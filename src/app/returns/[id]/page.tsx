'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ ONE RETURN TICKET — the approval chain, on screen.                       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Requirements 72 (Return Authorization — the auto-filled PO No. / GRN No.),
 * 73 (Return Approval Workflow), 74 (Store Verification, Accept or Reject with
 * a mandatory reason), 76/77 (the stock consequence) and 78 (the disposition).
 *
 * ── TWO THINGS THE PERSON READING THIS SCREEN MUST KNOW ───────────────────
 *
 * 1. STOCK MOVES ONLY WHEN THE STORE ACCEPTS. Raising the ticket moves nothing.
 *    Submitting it moves nothing. The Department Head approving it moves
 *    nothing. A ticket can sit at 'hod_approved' for a week with the goods on
 *    the store counter and not one gram has changed hands. The Store Verify
 *    panel at the bottom of this page is the single door, and it is one atomic
 *    commit for the whole ticket. That is why the panel makes you tick a box
 *    that says so out loud before it will submit.
 *
 * 2. A VENDOR RETURN AND AN INTERNAL RETURN HAVE OPPOSITE EFFECTS ON CENTRAL
 *    STOCK:
 *      internal  department -> central store. Goods STAY in the building.
 *                Department stock DOWN, central stock UP.
 *      vendor    central store -> out of the building, back to the supplier.
 *                Central stock DOWN, and no department leg at all.
 *    So this page never prints a bare "returned quantity". Every quantity is
 *    shown next to the direction it moved, and the sentence describing that
 *    direction is the SERVER'S (`ret.stock_effect`, `ret.central_stock_effect`)
 *    rendered verbatim — not a paraphrase written here that could drift out of
 *    step with the mover.
 *
 * ── WHY THIS PAGE RE-DERIVES NO PERMISSION ────────────────────────────────
 * Every button is gated on the `can` block that GET /api/returns/[id] computes
 * server-side. The page does not look at the user's role at all. That is
 * deliberate: `can.hod_approve` is canApproveAsChef (the ROLE, never the
 * department's head_user_id — that conflation was a live bug in the requisition
 * module), and `can.store_verify` is canIssueAsStore, which has NO ADMIN
 * BYPASS. An admin who is not a store manager sees no Verify panel here,
 * because accepting goods over a counter is a physical act. A second copy of
 * those rules living in this file is a second copy that can disagree with the
 * route that actually enforces them.
 *
 * Reads:  GET /api/returns/[id]        header + lines + auto-filled PO/GRN + can
 *         GET /api/returns/[id]/audit  stage timeline + resolved movement receipts
 * Writes: POST .../submit .../hod-approve .../hod-reject .../store-verify .../cancel
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import { fmtQtyNum } from '@/lib/pack-units';
import {
  ArrowLeft, Loader2, RefreshCw, CheckCircle2, XCircle, AlertTriangle, Lock,
  ShieldCheck, Send, Ban, Truck, Building2, Link2Off, ScrollText, Clock,
  ArrowDownToLine, ArrowUpFromLine, FileText, PackageCheck,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Wire shapes. Mirrors of what the two GET routes actually return — kept narrow
// on purpose, so a field this page reads is a field somebody deliberately put
// on the payload.
// ─────────────────────────────────────────────────────────────────────────────

/** The frozen dual-unit shape from pack-units. `qty_purchase` is a ROUNDED
 *  DERIVATIVE for display — never summed across materials, never stored. */
interface DualQty {
  qty: number; unit: string;
  qty_purchase: number; purchase_unit: string;
  pack_factor: number;
}

interface RetHeader {
  id: string; ret_number: string; kind: 'internal' | 'vendor'; status: string; date: string;
  department_id: string | null; department_name: string | null; department_code: string | null;
  grn_id: string | null; grn_number: string | null; grn_date: string | null;
  po_id: string | null; po_number: string | null; po_status: string | null;
  vendor_id: string | null; vendor_name: string | null;
  credit_note_no: string | null; credit_note_date: string | null; credit_note_amount: number | null;
  notes: string | null;
  drafted_by: string | null;
  submitted_at: string | null; submitted_by: string | null;
  hod_approved_at: string | null; hod_approved_by: string | null; hod_note: string | null;
  hod_rejected_at: string | null; hod_rejected_by: string | null; hod_rejected_reason: string | null;
  store_verified_at: string | null; store_verified_by: string | null; store_note: string | null;
  store_rejected_at: string | null; store_rejected_by: string | null; store_rejected_reason: string | null;
  cancelled_at: string | null; cancelled_by: string | null;
  /** Server-authored. Rendered verbatim — see the header comment. */
  kind_label: string;
  stock_effect: string;
  stock_moved: boolean;
}

interface RetLine {
  id: string; material_id: string; material_name: string; material_sku: string | null;
  quantity: number; unit: string; pack_factor: number; recipe_qty: number;
  reason: string; disposition: 'reusable' | 'wastage' | 'disposal';
  grn_item_id: string | null; po_item_id: string | null; req_item_id: string | null;
  accepted_qty: number; accepted_recipe_qty: number;
  store_rejected: number; store_reject_reason: string | null;
  dept_txn_id: string | null; inv_txn_id: string | null;
  notes: string | null;
  requested: DualQty; accepted: DualQty;
  pack_factor_snapshot: number; pack_factor_live: number; pack_factor_drift: boolean;
  /** req 72's auto-fill. BLANK on an internal line, honestly — see below. */
  po_number: string; grn_number: string; grn_date: string;
  rate_per_purchase_unit: number; rate_basis: 'purchase'; rate_source: string;
  value: number; accepted_value: number;
}

interface Gates {
  edit: boolean; delete: boolean; submit: boolean;
  hod_approve: boolean; hod_reject: boolean;
  store_verify: boolean; cancel: boolean;
}

interface TicketPayload {
  ret: RetHeader;
  items: RetLine[];
  can: Gates;
  meta: { po_return_window_days: number; stock_note: string };
}

interface LedgerTxn { id: string; type: string; quantity: number; notes?: string | null; created_at?: string | null }

interface AuditLine {
  id: string; material_name: string; is_write_off: boolean;
  dept_txn_id: string | null; inv_txn_id: string | null;
  dept_txn: LedgerTxn | null; inv_txn: LedgerTxn | null;
  receipts_resolved: boolean;
}

interface Stage {
  stage: string; label: string; status: string; event_type: string;
  at: string | null; by: string | null; note: string;
  moves_stock: boolean; stock_moved: boolean;
  accepted_lines: number | null; rejected_lines: number | null;
  central_delta_recipe_units: number | null;
}

interface AuditPayload {
  return: { central_stock_effect: string; stock_moves_at: string };
  stages: Stage[];
  lines: AuditLine[];
  integrity: { ok: boolean; faults: { line_id: string; material_name: string; fault: string }[] };
}

/** The store's per-line decision, before it is sent as ONE commit. */
interface Decision {
  rejected: boolean;
  reject_reason: string;
  /** In the LINE's unit (normally the purchase unit), as the store-verify route expects. */
  accepted_qty: string;
  disposition: 'reusable' | 'wastage' | 'disposal';
  note: string;
}

/** A refusal from the server, kept whole. `message` is rendered VERBATIM. */
interface ServerRefusal {
  http: number;
  message: string;
  code?: string;
  details?: {
    material_name?: string; department_name?: string;
    requested?: number; available?: number; consumed_since?: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting. Same shapes as the rest of the app.
// ─────────────────────────────────────────────────────────────────────────────

const inr = (v: number) =>
  '₹' + (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

const EPS = 1e-9;

function istWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.includes('Z') || iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

const STATUS_PILL: Record<string, { label: string; cls: string }> = {
  draft:        { label: 'Draft',                 cls: 'bg-[#FFF1E3] border-[#E8D5C4] text-[#6B5744]' },
  submitted:    { label: 'Submitted',             cls: 'bg-amber-50 border-amber-200 text-amber-800' },
  hod_approved: { label: 'Approved by Dept Head', cls: 'bg-blue-50 border-blue-200 text-blue-800' },
  verified:     { label: 'Verified by Store',     cls: 'bg-emerald-50 border-emerald-200 text-emerald-800' },
  hod_rejected: { label: 'Rejected by Dept Head', cls: 'bg-red-50 border-red-200 text-red-700' },
  cancelled:    { label: 'Cancelled',             cls: 'bg-gray-100 border-gray-300 text-gray-600' },
};

const DISPOSITION_LABEL: Record<string, string> = {
  reusable: 'Reusable',
  wastage:  'Wastage (write-off)',
  disposal: 'Disposal (write-off)',
};

/**
 * PURCHASE UNITS LEAD (owner rule). The secondary recipe-unit figure is shown
 * only when the pack actually converts — printing "= 2000 g" beside "2 kg" on
 * every row is noise, but printing nothing on a packed material hides the
 * number stock actually moved by.
 */
function DualQtyView({ d, className = '' }: { d: DualQty | undefined; className?: string }) {
  if (!d) return <span className="text-[#B0987F]">—</span>;
  const converts = Math.abs((Number(d.pack_factor) || 1) - 1) > EPS;
  return (
    <span className={className}>
      <span className="font-semibold">{fmtQtyNum(d.qty_purchase)}</span>{' '}
      <span className="text-[11px] text-[#8B7355]">{d.purchase_unit || d.unit}</span>
      {converts && (
        <span className="block text-[11px] text-[#B0987F]">
          = {fmtQtyNum(d.qty)} {d.unit}
        </span>
      )}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function ReturnTicketPage() {
  const params = useParams<{ id: string }>();
  const id = String(params?.id || '');

  const [data, setData] = useState<TicketPayload | null>(null);
  const [audit, setAudit] = useState<AuditPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const flash = (m: string) => { setToast(m); window.setTimeout(() => setToast(null), 4500); };

  // Stage-2 (HOD) inputs.
  const [hodNote, setHodNote] = useState('');
  const [hodReason, setHodReason] = useState('');

  // Stage-3 (Store) inputs. One decision per line, submitted together.
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [storeNote, setStoreNote] = useState('');
  const [confirmMoves, setConfirmMoves] = useState(false);
  /** The last server refusal, kept whole so the message can be shown VERBATIM. */
  const [refusal, setRefusal] = useState<ServerRefusal | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true); setLoadError(null);
    try {
      // Both reads run the same visibility rule, so they succeed or fail together.
      const [tRes, aRes] = await Promise.all([
        fetch(`/api/returns/${id}`),
        fetch(`/api/returns/${id}/audit`),
      ]);
      if (tRes.status === 401 || tRes.status === 403) { setForbidden(true); setData(null); return; }
      const tJson = await tRes.json();
      if (!tRes.ok) throw new Error(tJson?.error || 'Failed to load this return');
      setData(tJson);
      // The audit is decoration, not the record: a ticket whose timeline fails
      // to load still shows its lines and its actions rather than a blank page.
      if (aRes.ok) setAudit(await aRes.json()); else setAudit(null);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const ret = data?.ret;
  const items = useMemo(() => data?.items ?? [], [data]);
  const can = data?.can;
  const isVendor = ret?.kind === 'vendor';

  /**
   * Seed one decision per line the moment the store can act, defaulting to
   * ACCEPT THE FULL LINE. Requirement 74 asks for Accept or Reject; a store
   * that agrees with the ticket should not have to retype quantities it already
   * approved. Re-seeds whenever the line set changes.
   */
  useEffect(() => {
    if (!can?.store_verify) return;
    setDecisions((prev) => {
      const next: Record<string, Decision> = {};
      for (const it of items) {
        next[it.id] = prev[it.id] ?? {
          rejected: false,
          reject_reason: '',
          accepted_qty: String(it.quantity ?? ''),
          disposition: it.disposition || 'reusable',
          note: '',
        };
      }
      return next;
    });
  }, [can?.store_verify, items]);

  const setDecision = (lineId: string, patch: Partial<Decision>) =>
    setDecisions((p) => ({ ...p, [lineId]: { ...p[lineId], ...patch } }));

  const auditLineById = useMemo(() => {
    const m = new Map<string, AuditLine>();
    for (const l of audit?.lines ?? []) m.set(l.id, l);
    return m;
  }, [audit]);

  // ───────────────────────────────────────────────────────────────────────────
  // Chain actions. Every one of them re-reads the ticket afterwards rather than
  // patching local state: the server owns the status, the gates and (at verify)
  // the movement receipts, and a hand-patched copy is how a screen ends up
  // offering a button the route will refuse.
  // ───────────────────────────────────────────────────────────────────────────

  async function post(verb: string, body: unknown, okMsg: string) {
    setBusy(verb); setRefusal(null);
    try {
      const res = await api(`/api/returns/${id}/${verb}`, { method: 'POST', body });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRefusal({ http: res.status, message: String(j?.error || `HTTP ${res.status}`), code: j?.code, details: j?.details });
        flash(String(j?.error || 'Refused'));
        return false;
      }
      flash(okMsg);
      await load();
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      setRefusal({ http: 0, message: msg });
      flash(msg);
      return false;
    } finally {
      setBusy(null);
    }
  }

  const doSubmit = () => post('submit', {}, 'Sent to the Department Head. No stock has moved.');

  const doHodApprove = () =>
    post('hod-approve', { note: hodNote.trim() },
      'Approved. The ticket is now with the Store — still no stock has moved.');

  const doHodReject = () => {
    // Mirrors the route's own refusal so the click never leaves the page. The
    // route enforces it regardless; this only saves a round trip.
    if (!hodReason.trim()) { flash('A rejection needs a reason — say why, so the department knows what to fix.'); return; }
    return post('hod-reject', { reason: hodReason.trim() }, 'Rejected. Stock is exactly where it was.');
  };

  const doCancel = () => post('cancel', {}, 'Cancelled. Nothing moved.');

  /**
   * STORE VERIFY — ONE COMMIT FOR THE WHOLE TICKET.
   *
   * Every line is sent, accepted or rejected, in a single POST. It is not a
   * per-line save loop, and that is the point: the route claims the status once
   * (`WHERE status='hod_approved'`) and moves every accepted line inside one
   * transaction, so a refusal on line 3 of 5 rolls the whole thing back and
   * leaves the ticket re-verifiable rather than half-accepted.
   *
   * The checks below are MIRRORS of the route's refusals, not the enforcement.
   * The route re-checks all of them against the lines as they are at commit
   * time, which is the only moment that counts.
   */
  async function doStoreVerify() {
    if (!ret) return;
    if (!confirmMoves) { flash('Tick the confirmation first — submitting this is what moves stock.'); return; }

    const header = storeNote.trim();
    const payload: Record<string, unknown>[] = [];

    for (const it of items) {
      const d = decisions[it.id];
      if (!d) { flash(`No decision recorded for ${it.material_name}. Reload the page.`); return; }

      if (d.rejected) {
        // Requirement 74's "with a mandatory reason", enforced in the UI as the
        // acceptance criteria ask. A rejected line moves NOTHING.
        if (!d.reject_reason.trim()) {
          flash(`Rejecting ${it.material_name} needs a reason — requirement 74 makes it mandatory.`);
          return;
        }
        payload.push({ id: it.id, rejected: true, reject_reason: d.reject_reason.trim(), note: d.note.trim() });
        continue;
      }

      const qty = Number(d.accepted_qty);
      const lineQty = Number(it.quantity) || 0;
      if (!Number.isFinite(qty) || qty <= 0) {
        flash(`Accepted quantity for ${it.material_name} must be greater than zero — to take nothing, reject the line with a reason.`);
        return;
      }
      // REFUSE, NEVER CLAMP — accepting more than the ticket claims is a
      // different quantity of goods than anybody approved.
      if (qty > lineQty + 1e-6) {
        flash(`Cannot accept ${fmtQtyNum(qty)} ${it.unit} of ${it.material_name}: the return only claims ${fmtQtyNum(lineQty)}.`);
        return;
      }
      // A short accept is stock the ticket said was coming back and the store
      // did not take. Unexplained, it is exactly the unlabelled movement the
      // Return Report exists to prevent.
      if (qty < lineQty - 1e-6 && !d.note.trim() && !header) {
        flash(`Accepting only ${fmtQtyNum(qty)} of ${fmtQtyNum(lineQty)} ${it.unit} for ${it.material_name} needs a note explaining the shortfall.`);
        return;
      }
      payload.push({
        id: it.id,
        rejected: false,
        accepted_qty: qty,
        // req 78. The STORE inspects, so the store may overrule the disposition
        // the department claimed. Internal only — a vendor return's goods go
        // back to the supplier whatever state they are in, and the route
        // refuses a write-off there.
        ...(isVendor ? {} : { disposition: d.disposition }),
        note: d.note.trim(),
      });
    }

    const ok = await post('store-verify', { note: header, items: payload }, 'Verified. Stock has moved — the receipts are on each line below.');
    if (ok) { setConfirmMoves(false); setStoreNote(''); }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Render
  // ───────────────────────────────────────────────────────────────────────────

  if (forbidden) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center p-6">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 max-w-md text-center">
          <Lock className="w-10 h-10 text-[#af4408] mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-[#2D1B0E] mb-1">Not your paperwork</h1>
          <p className="text-sm text-[#8B7355]">
            You can only open return tickets for departments you have access to.
          </p>
          <Link href="/returns" className="inline-block mt-4 text-sm text-[#af4408] hover:underline">← Back to Returns</Link>
        </div>
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center">
        <div className="flex items-center gap-2 text-[#8B7355] text-sm">
          <Loader2 className="w-5 h-5 animate-spin" /> Loading return…
        </div>
      </div>
    );
  }

  if (!ret) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center p-6">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 max-w-md text-center">
          <AlertTriangle className="w-10 h-10 text-[#af4408] mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-[#2D1B0E] mb-1">Return not found</h1>
          <p className="text-sm text-[#8B7355]">{loadError || 'This return ticket does not exist.'}</p>
          <Link href="/returns" className="inline-block mt-4 text-sm text-[#af4408] hover:underline">← Back to Returns</Link>
        </div>
      </div>
    );
  }

  const pill = STATUS_PILL[ret.status] ?? { label: ret.status, cls: 'bg-gray-100 border-gray-300 text-gray-700' };
  const anyAction = !!(can && (can.submit || can.hod_approve || can.hod_reject || can.store_verify || can.cancel));

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div className="min-w-0">
            <Link href="/returns" className="inline-flex items-center gap-1.5 text-sm text-[#8B7355] hover:text-[#af4408]">
              <ArrowLeft className="w-4 h-4" /> Returns
            </Link>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] mt-1 flex flex-wrap items-center gap-3">
              {ret.ret_number}
              <span className={`text-[12px] font-semibold px-2 py-1 rounded-lg border ${pill.cls}`}>{pill.label}</span>
              <span className={`inline-flex items-center gap-1.5 text-[12px] font-semibold px-2 py-1 rounded-lg border ${
                isVendor ? 'bg-violet-50 border-violet-200 text-violet-800' : 'bg-sky-50 border-sky-200 text-sky-800'}`}>
                {isVendor ? <Truck className="w-3.5 h-3.5" /> : <Building2 className="w-3.5 h-3.5" />}
                {ret.kind_label}
              </span>
            </h1>
          </div>
          <button onClick={load} disabled={loading}
                  className="self-start inline-flex items-center gap-2 px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm text-[#6B5744] hover:bg-white disabled:opacity-50">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Refresh
          </button>
        </div>

        {/*
          THE DIRECTION BANNER. Both sentences are the server's own words
          (ret.stock_effect, meta.stock_note) rendered verbatim, so the screen
          and the mover cannot describe the movement differently. This is where
          a reader hits the two facts that matter: stock moves only on Store
          Accept, and the two kinds of return push central stock opposite ways.
        */}
        <div className={`rounded-xl border p-3.5 text-[13px] flex gap-2.5 ${
          isVendor ? 'bg-violet-50 border-violet-200 text-violet-900' : 'bg-sky-50 border-sky-200 text-sky-900'}`}>
          {isVendor ? <ArrowUpFromLine className="w-5 h-5 shrink-0 mt-0.5" /> : <ArrowDownToLine className="w-5 h-5 shrink-0 mt-0.5" />}
          <div className="space-y-1">
            <div className="font-semibold">{ret.stock_effect}</div>
            <div className="opacity-90">{data?.meta?.stock_note}</div>
            {ret.stock_moved && (
              <div className="inline-flex items-center gap-1.5 font-medium">
                <PackageCheck className="w-4 h-4" /> The store has accepted this ticket — the movement is posted. The receipts are on each line below.
              </div>
            )}
          </div>
        </div>

        {/* ── Ticket facts ───────────────────────────────────────────────── */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4">
          <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-3 text-[13px]">
            <Fact label="Return date" value={ret.date} />
            <Fact label="Raised by" value={ret.drafted_by || '—'} />
            {isVendor ? (
              <>
                <Fact label="Vendor" value={ret.vendor_name || '—'} />
                <Fact label="PO No." value={ret.po_number || '—'} />
                <Fact label="GRN No." value={ret.grn_number || '—'} />
                <Fact label="GRN date" value={ret.grn_date || '—'} />
              </>
            ) : (
              <>
                <Fact label="Department" value={ret.department_name || '—'} />
                {/*
                  req 72 asks the ticket to auto-fill PO No. and GRN No. On an
                  INTERNAL return that chain physically does not exist — the
                  department ledger carries no grn_id and no purchase_id, and
                  department stock is pooled per (department, material) with no
                  lot tracking. So this says "not linkable" rather than showing
                  a nearest match. A blank the user can see is honest; a
                  plausible wrong PO number is a wrong credit note.
                */}
                <Fact label="PO No. / GRN No." value={
                  <span className="inline-flex items-center gap-1.5 text-[#8B7355]">
                    <Link2Off className="w-3.5 h-3.5" /> Not linkable
                  </span>
                } hint="Department stock is pooled with no lot tracking, so returned goods cannot name the receipt they arrived on." />
              </>
            )}
            {isVendor && (
              <>
                <Fact label="Credit note no." value={ret.credit_note_no || '—'} />
                <Fact label="Credit note date" value={ret.credit_note_date || '—'} />
                <Fact
                  label="Credit note amount"
                  value={inr(Number(ret.credit_note_amount) || 0)}
                  hint="Recorded only. It never touches stock, average price or any recipe cost."
                />
              </>
            )}
          </dl>
          {ret.notes && (
            <p className="mt-3 pt-3 border-t border-[#F0E4D6] text-[13px] text-[#6B5744]">
              <span className="text-[#8B7355]">Notes: </span><span className="italic">{ret.notes}</span>
            </p>
          )}
        </div>

        {/* ── Lines ──────────────────────────────────────────────────────── */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-[#F0E4D6] flex items-center gap-2">
            <ScrollText className="w-4 h-4 text-[#af4408]" />
            <h2 className="font-semibold text-[#2D1B0E]">Items ({items.length})</h2>
            <span className="text-[11px] text-[#8B7355] ml-auto">Quantities lead with the purchase unit</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-[#FFF8F0] text-[11px] uppercase tracking-wide text-[#8B7355]">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Item</th>
                  <th className="text-right px-3 py-2 font-medium">Claimed</th>
                  <th className="text-left px-3 py-2 font-medium">Reason</th>
                  <th className="text-left px-3 py-2 font-medium">Disposition</th>
                  <th className="text-left px-3 py-2 font-medium">PO No.</th>
                  <th className="text-left px-3 py-2 font-medium">GRN No.</th>
                  <th className="text-right px-3 py-2 font-medium">Value</th>
                  <th className="text-left px-4 py-2 font-medium">Store outcome</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F5EBE0]">
                {items.map((it) => {
                  const rejected = Number(it.store_rejected) === 1;
                  const al = auditLineById.get(it.id);
                  const writeOff = it.disposition !== 'reusable';
                  return (
                    <tr key={it.id} className="align-top">
                      <td className="px-4 py-3">
                        <div className="font-medium text-[#2D1B0E]">{it.material_name}</div>
                        {it.material_sku && <div className="text-[11px] text-[#B0987F]">#{it.material_sku}</div>}
                        {it.pack_factor_drift && (
                          <div className="mt-1 inline-flex items-start gap-1 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                            <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                            {/* The factor is snapshotted so a movement reads back with the
                                factor it was MADE with. Say so rather than let the stored
                                quantity and today's pack quietly disagree. */}
                            <span>Pack changed since this line was raised ({fmtQtyNum(it.pack_factor_snapshot)} → {fmtQtyNum(it.pack_factor_live)}). It will move by the snapshotted factor.</span>
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right whitespace-nowrap"><DualQtyView d={it.requested} /></td>
                      <td className="px-3 py-3 text-[#6B5744] max-w-[16rem]"><span className="italic">{it.reason || '—'}</span></td>
                      <td className="px-3 py-3">
                        <span className={`text-[11px] px-1.5 py-0.5 rounded border ${
                          writeOff ? 'bg-red-50 border-red-200 text-red-700' : 'bg-[#FFF8F0] border-[#E8D5C4] text-[#6B5744]'}`}>
                          {DISPOSITION_LABEL[it.disposition] || it.disposition}
                        </span>
                        {writeOff && (
                          <div className="text-[11px] text-[#8B7355] mt-0.5">Never re-enters the sellable pool.</div>
                        )}
                      </td>
                      {/* req 72 auto-fill: real on a vendor line (joined from the GRN
                          line the return was raised from), deliberately blank and
                          LABELLED on an internal line. */}
                      <td className="px-3 py-3 whitespace-nowrap">{it.po_number || <NotLinkable internal={!isVendor} />}</td>
                      <td className="px-3 py-3 whitespace-nowrap">{it.grn_number || <NotLinkable internal={!isVendor} />}</td>
                      <td className="px-3 py-3 text-right whitespace-nowrap">
                        <div>{inr(it.value)}</div>
                        {/* rate-basis: purchase — ₹ per PURCHASE unit against a
                            purchase-unit quantity. Display only. */}
                        <div className="text-[11px] text-[#B0987F]">
                          {inr(it.rate_per_purchase_unit)}/{it.requested?.purchase_unit || it.unit}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {ret.status !== 'verified' ? (
                          <span className="text-[#B0987F]">Awaiting store</span>
                        ) : rejected ? (
                          <div className="text-red-700">
                            <div className="inline-flex items-center gap-1 font-medium"><XCircle className="w-3.5 h-3.5" /> Rejected</div>
                            <div className="text-[11px] text-[#6B5744] italic">{it.store_reject_reason || '—'}</div>
                            <div className="text-[11px] text-[#8B7355]">Nothing moved.</div>
                          </div>
                        ) : (
                          <div className="text-emerald-800">
                            <div className="inline-flex items-center gap-1 font-medium"><CheckCircle2 className="w-3.5 h-3.5" /> Accepted</div>
                            <DualQtyView d={it.accepted} className="block text-emerald-900" />
                            <Receipts line={it} audit={al} isVendor={isVendor} />
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {items.length === 0 && (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-[#8B7355]">No items on this ticket.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Integrity faults. A verified line with a quantity and a NULL receipt is
            a DETECTABLE fault rather than a silent zero-credit — that detectability
            is the whole reason the receipts are written back onto the line. */}
        {audit && !audit.integrity.ok && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-3.5 text-[13px] text-red-800">
            <div className="font-semibold inline-flex items-center gap-1.5 mb-1">
              <AlertTriangle className="w-4 h-4" /> Movement receipts do not add up
            </div>
            <ul className="list-disc pl-5 space-y-0.5">
              {audit.integrity.faults.map((f, i) => (
                <li key={i}><b>{f.material_name}:</b> {f.fault}</li>
              ))}
            </ul>
          </div>
        )}

        {/* ── Stage timeline ─────────────────────────────────────────────── */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4">
          <h2 className="font-semibold text-[#2D1B0E] flex items-center gap-2 mb-3">
            <Clock className="w-4 h-4 text-[#af4408]" /> Approval chain
          </h2>
          {!audit || audit.stages.length === 0 ? (
            <p className="text-[13px] text-[#8B7355]">No workflow events recorded yet.</p>
          ) : (
            <ol className="space-y-3">
              {audit.stages.map((s, i) => (
                <li key={`${s.event_type}-${i}`} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span className={`w-2.5 h-2.5 rounded-full mt-1.5 ${s.stock_moved ? 'bg-emerald-500' : 'bg-[#E8D5C4]'}`} />
                    {i < audit.stages.length - 1 && <span className="flex-1 w-px bg-[#F0E4D6] my-1" />}
                  </div>
                  <div className="pb-1 text-[13px]">
                    <div className="font-medium text-[#2D1B0E]">{s.label}</div>
                    <div className="text-[12px] text-[#8B7355]">{istWhen(s.at)} · {s.by || '—'}</div>
                    {s.note && <div className="text-[12px] text-[#6B5744] italic">“{s.note}”</div>}
                    {s.moves_stock ? (
                      <div className={`text-[12px] mt-0.5 ${s.stock_moved ? 'text-emerald-700' : 'text-[#8B7355]'}`}>
                        {s.stock_moved
                          ? <>Stock moved — {s.accepted_lines} accepted, {s.rejected_lines} rejected. Central change {signedRecipe(s.central_delta_recipe_units)} recipe units ({(s.central_delta_recipe_units ?? 0) >= 0 ? 'back into the store' : 'out of the store'}).</>
                          : <>No stock moved — every line was rejected or written off.</>}
                      </div>
                    ) : (
                      <div className="text-[12px] text-[#8B7355] mt-0.5">No stock moved at this step.</div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>

        {/* ── The last server refusal, VERBATIM ──────────────────────────── */}
        {refusal && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-[13px] text-red-800">
            <div className="font-semibold inline-flex items-center gap-1.5 mb-1.5">
              <AlertTriangle className="w-4 h-4" />
              {refusal.http === 409 ? 'The stock says no' : 'Refused'}
              {refusal.code && <span className="font-mono text-[11px] font-normal opacity-70">{refusal.code}</span>}
            </div>
            {/*
              The server's sentence, WORD FOR WORD. It already names the material
              and the quantity that is actually available, and a paraphrase here
              would be a second, staler explanation of a number the operator has
              to act on. Nothing moved — a refused verify rolls the whole
              transaction back and leaves the ticket re-verifiable.
            */}
            <p className="whitespace-pre-line">{refusal.message}</p>
            {refusal.details && (refusal.details.available != null || refusal.details.requested != null) && (
              <dl className="mt-2 pt-2 border-t border-red-200 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[12px]">
                {refusal.details.material_name && <DetailCell k="Item" v={refusal.details.material_name} />}
                {refusal.details.department_name && <DetailCell k="Department" v={refusal.details.department_name} />}
                {refusal.details.requested != null && <DetailCell k="Requested (recipe units)" v={fmtQtyNum(refusal.details.requested)} />}
                {refusal.details.available != null && <DetailCell k="Available (recipe units)" v={fmtQtyNum(refusal.details.available)} />}
                {refusal.details.consumed_since != null && <DetailCell k="Consumed since (recipe units)" v={fmtQtyNum(refusal.details.consumed_since)} />}
              </dl>
            )}
          </div>
        )}

        {/* ── Stage 1: submit (the raiser) ───────────────────────────────── */}
        {can?.submit && (
          <ActionCard title="Send for approval" icon={<Send className="w-4 h-4" />}>
            <p className="text-[13px] text-[#6B5744]">
              This hands the ticket to the Department Head. It moves no stock.
            </p>
            <div className="flex justify-end">
              <button onClick={doSubmit} disabled={busy !== null}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white disabled:opacity-50">
                {busy === 'submit' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Submit for approval
              </button>
            </div>
          </ActionCard>
        )}

        {/* ── Stage 2: Department Head / Manager (req 73) ────────────────── */}
        {(can?.hod_approve || can?.hod_reject) && (
          <ActionCard title="Department Head approval" icon={<ShieldCheck className="w-4 h-4" />}>
            <p className="text-[13px] text-[#6B5744]">
              Requirement 73. Approving passes the ticket to the Store — <b>it does not move stock</b>.
              The goods only change hands when the Store accepts them.
            </p>
            {can.hod_approve && (
              <input
                value={hodNote} onChange={(e) => setHodNote(e.target.value)}
                placeholder="Note (optional)"
                className="w-full px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]"
              />
            )}
            {can.hod_reject && (
              <input
                value={hodReason} onChange={(e) => setHodReason(e.target.value)}
                placeholder="Reason — required to reject"
                className="w-full px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]"
              />
            )}
            <div className="flex flex-wrap gap-2 justify-end">
              {can.hod_reject && (
                <button onClick={doHodReject} disabled={busy !== null || !hodReason.trim()}
                        title={!hodReason.trim() ? 'Enter a reason first' : undefined}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed">
                  {busy === 'hod-reject' ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />} Reject
                </button>
              )}
              {can.hod_approve && (
                <button onClick={doHodApprove} disabled={busy !== null}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white disabled:opacity-50">
                  {busy === 'hod-approve' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Approve → send to Store
                </button>
              )}
            </div>
          </ActionCard>
        )}

        {/* ── Stage 3: STORE VERIFICATION (req 74) — THE ONLY DOOR ───────── */}
        {can?.store_verify && (
          <div className="bg-white border-2 border-[#af4408] rounded-xl overflow-hidden">
            <div className="px-4 py-3 bg-[#FFF1E3] border-b border-[#E8D5C4]">
              <h2 className="font-semibold text-[#af4408] flex items-center gap-2">
                <PackageCheck className="w-4 h-4" /> Store verification — Accept or Reject each item
              </h2>
              <p className="text-[12px] text-[#6B5744] mt-1">
                Requirement 74. This is the <b>only</b> step in the whole returns module that moves stock, and it
                posts <b>every line at once</b> — one commit. For this ticket: <b>{ret.stock_effect}</b>{' '}
                A rejected line moves nothing at all and needs a reason.
              </p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead className="bg-[#FFF8F0] text-[11px] uppercase tracking-wide text-[#8B7355]">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Item</th>
                    <th className="text-right px-3 py-2 font-medium">Claimed</th>
                    <th className="text-left px-3 py-2 font-medium">Decision</th>
                    <th className="text-left px-3 py-2 font-medium">Accept qty / Reason</th>
                    {!isVendor && <th className="text-left px-3 py-2 font-medium">Condition</th>}
                    <th className="text-left px-4 py-2 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F5EBE0]">
                  {items.map((it) => {
                    const d = decisions[it.id];
                    if (!d) return null;
                    const needsReason = d.rejected && !d.reject_reason.trim();
                    return (
                      <tr key={it.id} className="align-top">
                        <td className="px-4 py-3">
                          <div className="font-medium">{it.material_name}</div>
                          <div className="text-[11px] text-[#8B7355] italic">{it.reason}</div>
                        </td>
                        <td className="px-3 py-3 text-right whitespace-nowrap"><DualQtyView d={it.requested} /></td>
                        <td className="px-3 py-3">
                          <div className="inline-flex rounded-lg border border-[#E8D5C4] overflow-hidden">
                            <button type="button" onClick={() => setDecision(it.id, { rejected: false })}
                                    className={`px-2.5 py-1.5 text-[12px] font-medium ${!d.rejected ? 'bg-emerald-600 text-white' : 'bg-white text-[#6B5744] hover:bg-[#FFF1E3]'}`}>
                              Accept
                            </button>
                            <button type="button" onClick={() => setDecision(it.id, { rejected: true })}
                                    className={`px-2.5 py-1.5 text-[12px] font-medium border-l border-[#E8D5C4] ${d.rejected ? 'bg-red-600 text-white' : 'bg-white text-[#6B5744] hover:bg-[#FFF1E3]'}`}>
                              Reject
                            </button>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          {d.rejected ? (
                            <>
                              <input
                                value={d.reject_reason}
                                onChange={(e) => setDecision(it.id, { reject_reason: e.target.value })}
                                placeholder="Reason — required (req 74)"
                                className={`w-full min-w-[13rem] px-2.5 py-1.5 border rounded-lg text-[13px] bg-[#FFF8F0] focus:outline-none ${
                                  needsReason ? 'border-red-400 focus:border-red-500' : 'border-[#E8D5C4] focus:border-[#af4408]'}`}
                              />
                              {needsReason && <div className="text-[11px] text-red-600 mt-0.5">A rejection needs a reason.</div>}
                              <div className="text-[11px] text-[#8B7355] mt-0.5">Nothing will move for this line.</div>
                            </>
                          ) : (
                            <>
                              {/* In the LINE's unit — which is the purchase unit the
                                  operator typed. The route converts once, using the
                                  pack factor SNAPSHOTTED on the line. */}
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="number" min={0} step="any" value={d.accepted_qty}
                                  onChange={(e) => setDecision(it.id, { accepted_qty: e.target.value })}
                                  className="w-28 px-2.5 py-1.5 border border-[#E8D5C4] rounded-lg text-[13px] bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]"
                                />
                                <span className="text-[11px] text-[#8B7355]">{it.unit}</span>
                              </div>
                              {Number(d.accepted_qty) < Number(it.quantity) - 1e-6 && (
                                <div className="text-[11px] text-amber-800 mt-0.5">
                                  Short of the {fmtQtyNum(it.quantity)} {it.unit} claimed — add a note explaining it.
                                </div>
                              )}
                            </>
                          )}
                        </td>
                        {!isVendor && (
                          <td className="px-3 py-3">
                            {/* req 78. The store inspects, so the store may overrule
                                the department's claim. A write-off debits the
                                department and credits central NOTHING — unusable
                                goods never re-enter the sellable pool. */}
                            <select
                              value={d.disposition} disabled={d.rejected}
                              onChange={(e) => setDecision(it.id, { disposition: e.target.value as Decision['disposition'] })}
                              className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg text-[12px] bg-[#FFF8F0] focus:outline-none focus:border-[#af4408] disabled:opacity-50">
                              <option value="reusable">Reusable → back into store stock</option>
                              <option value="wastage">Wastage → write off, no store credit</option>
                              <option value="disposal">Disposal → write off, no store credit</option>
                            </select>
                          </td>
                        )}
                        <td className="px-4 py-3">
                          <input
                            value={d.note} onChange={(e) => setDecision(it.id, { note: e.target.value })}
                            placeholder="Note (optional)"
                            className="w-full min-w-[10rem] px-2.5 py-1.5 border border-[#E8D5C4] rounded-lg text-[13px] bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="p-4 border-t border-[#F0E4D6] space-y-3 bg-[#FFF8F0]">
              <input
                value={storeNote} onChange={(e) => setStoreNote(e.target.value)}
                placeholder="Store note for the whole ticket (optional)"
                className="w-full px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-white focus:outline-none focus:border-[#af4408]"
              />
              {/*
                THE CONFIRMATION. Not ceremony: this button is the single door
                stock moves through in the entire returns module, and the
                direction differs by kind. Making the operator tick a sentence
                that names the direction is cheaper than a wrong movement.
              */}
              <label className="flex items-start gap-2.5 text-[13px] text-[#2D1B0E] cursor-pointer">
                <input type="checkbox" checked={confirmMoves} onChange={(e) => setConfirmMoves(e.target.checked)}
                       className="mt-0.5 w-4 h-4 accent-[#af4408]" />
                <span>
                  I have physically checked these goods. <b>Submitting this moves stock now</b> — {ret.stock_effect}{' '}
                  Rejected lines move nothing.
                </span>
              </label>
              <div className="flex justify-end">
                <button onClick={doStoreVerify} disabled={busy !== null || !confirmMoves}
                        title={!confirmMoves ? 'Tick the confirmation first' : undefined}
                        className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg text-sm font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white disabled:opacity-50 disabled:cursor-not-allowed">
                  {busy === 'store-verify' ? <Loader2 className="w-4 h-4 animate-spin" /> : <PackageCheck className="w-4 h-4" />}
                  Submit verification — moves stock
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Withdraw ───────────────────────────────────────────────────── */}
        {can?.cancel && (
          <div className="flex justify-end">
            <button onClick={doCancel} disabled={busy !== null}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-medium border border-[#E8D5C4] text-[#6B5744] hover:bg-white disabled:opacity-50">
              {busy === 'cancel' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ban className="w-4 h-4" />} Cancel this return
            </button>
          </div>
        )}

        {/* Read-only. Says WHY there are no buttons, so a staff member does not
            read a missing panel as a broken page. */}
        {!anyAction && (
          <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3.5 text-[13px] text-[#6B5744] flex gap-2">
            <FileText className="w-4 h-4 text-[#af4408] shrink-0 mt-0.5" />
            <span>
              This ticket is read-only for you.
              {ret.status === 'verified'
                ? ' It has been verified by the Store and its stock movement is posted — verified tickets are never edited, only superseded by a new return.'
                : ' Department Head approval and Store verification are done by the people who hold those roles.'}
            </span>
          </div>
        )}

        {/* Who signed what. Stays visible after the buttons are gone. */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 text-[12px] text-[#6B5744]">
          <h3 className="font-semibold text-[#2D1B0E] text-[13px] mb-2">Signatures</h3>
          <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5">
            <Sig label="Submitted" at={ret.submitted_at} by={ret.submitted_by} />
            <Sig label="Dept Head approved" at={ret.hod_approved_at} by={ret.hod_approved_by} note={ret.hod_note} />
            {ret.hod_rejected_at && <Sig label="Dept Head rejected" at={ret.hod_rejected_at} by={ret.hod_rejected_by} note={ret.hod_rejected_reason} />}
            <Sig label="Store verified" at={ret.store_verified_at} by={ret.store_verified_by} note={ret.store_note} />
            {ret.store_rejected_at && <Sig label="Store rejected all lines" at={ret.store_rejected_at} by={ret.store_rejected_by} note={ret.store_rejected_reason} />}
            {ret.cancelled_at && <Sig label="Cancelled" at={ret.cancelled_at} by={ret.cancelled_by} />}
          </div>
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 bg-[#2D1B0E] text-white text-sm px-4 py-2.5 rounded-lg shadow-lg max-w-[92vw]">
          {toast}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Small presentational pieces
// ─────────────────────────────────────────────────────────────────────────────

function Fact({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-[#8B7355]">{label}</dt>
      <dd className="text-[#2D1B0E] font-medium mt-0.5">{value}</dd>
      {hint && <dd className="text-[11px] text-[#B0987F] mt-0.5">{hint}</dd>}
    </div>
  );
}

/**
 * req 72's honest blank. An internal return has no GRN and no PO to name, so
 * the cell says that instead of showing an em-dash the reader might take for
 * "not filled in yet" — or, far worse, a nearest match.
 */
function NotLinkable({ internal }: { internal: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-[#B0987F]"
          title={internal
            ? 'Internal department return — department stock is pooled with no lot tracking, so these goods cannot name the receipt they arrived on.'
            : 'Not recorded on this line.'}>
      <Link2Off className="w-3 h-3" /> {internal ? 'Not linkable' : '—'}
    </span>
  );
}

/**
 * THE MOVEMENT RECEIPTS. Non-null ids are the on-the-row proof that this line's
 * stock moved, and moved once. The signed ledger quantity is shown because the
 * SIGN is the direction: the department row is negative (goods left the
 * department) and the central row is POSITIVE on an internal return and
 * NEGATIVE on a vendor return. Same module, opposite signs — that is the point.
 */
function Receipts({ line, audit, isVendor }: { line: RetLine; audit: AuditLine | undefined; isVendor: boolean }) {
  const deptId = line.dept_txn_id || audit?.dept_txn_id || null;
  const invId = line.inv_txn_id || audit?.inv_txn_id || null;
  if (!deptId && !invId) return null;
  return (
    <div className="mt-1 space-y-0.5 text-[11px] text-[#6B5744]">
      {deptId && (
        <div className="font-mono break-all" title={`department_material_transactions.${deptId}`}>
          <span className="font-sans text-[#8B7355]">Dept ledger </span>{deptId}
          {audit?.dept_txn && <span className="font-sans"> · {audit.dept_txn.type} {fmtQtyNum(audit.dept_txn.quantity)}</span>}
        </div>
      )}
      {invId ? (
        <div className="font-mono break-all" title={`inventory_transactions.${invId}`}>
          <span className="font-sans text-[#8B7355]">{isVendor ? 'Central debit ' : 'Central credit '}</span>{invId}
          {audit?.inv_txn && <span className="font-sans"> · {audit.inv_txn.type} {fmtQtyNum(audit.inv_txn.quantity)}</span>}
        </div>
      ) : (
        audit?.is_write_off && (
          <div className="text-[#8B7355]">No central credit — written off, so it never re-enters the sellable pool.</div>
        )
      )}
    </div>
  );
}

function ActionCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-3">
      <h2 className="font-semibold text-[#2D1B0E] flex items-center gap-2">
        <span className="text-[#af4408]">{icon}</span> {title}
      </h2>
      {children}
    </div>
  );
}

function DetailCell({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="uppercase tracking-wide opacity-70 text-[10px]">{k}</div>
      <div className="font-semibold">{v}</div>
    </div>
  );
}

function Sig({ label, at, by, note }: { label: string; at: string | null; by: string | null; note?: string | null }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <span className="text-[#8B7355]">{label}:</span>
      <span className="text-[#2D1B0E]">{at ? `${istWhen(at)} · ${by || '—'}` : 'not yet'}</span>
      {note && <span className="italic">“{note}”</span>}
    </div>
  );
}

/** Signed, always — an unsigned "returned quantity" hides which way it went. */
function signedRecipe(v: number | null): string {
  const n = Number(v) || 0;
  return (n > 0 ? '+' : n < 0 ? '−' : '') + fmtQtyNum(Math.abs(n));
}
