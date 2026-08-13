'use client';

/**
 * MATERIAL RETURNS — the queue, and the two ways to raise a ticket.
 * Requirements 72 (Return Authorization), 73 (Approval Workflow), 77 (Internal
 * Department Returns) and 78 (Disposal & Wastage) as they appear on screen.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ NOTHING ON THIS PAGE MOVES STOCK. NOT THE DRAFT, NOT THE SUBMIT.         ║
 * ║ Stock moves at exactly ONE point in the whole module — inside the        ║
 * ║ store-verify transaction, on the lines the STORE ACCEPTS.                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 *   raise (here) → HOD / Manager approves → reaches the Store
 *                → Store verifies, Accept or Reject with a mandatory reason
 *                                  ↑
 *                       the grams move HERE, once, atomically
 *
 * So every quantity this page shows is a FORECAST, not a reservation. Two
 * tickets can be drafted against the same 5 kg; the second Accept will
 * correctly refuse. Nothing here decrements anything, and nothing here should
 * ever be "helpfully" made to.
 *
 * ── THE TWO KINDS ARE OPPOSITE, WHICH IS WHY THEY ARE TWO BUTTONS ──────────
 * The kind is chosen by the route the user takes INTO the form, never by a
 * dropdown inside one shared form that could be mis-set on a ticket that is
 * otherwise ready to send:
 *
 *   Return to VENDOR    goods go back OUT of the building to the supplier.
 *                       On Accept, CENTRAL STOCK GOES DOWN. There is no
 *                       department leg. The money is a credit note, recorded
 *                       only. Anchored on a GRN LINE, because that is the only
 *                       place a real PO No., GRN No. and rate live together.
 *
 *   Return to STORE     goods come back from a DEPARTMENT to the central store
 *   (internal)          and never leave the building. On Accept, DEPARTMENT
 *                       STOCK GOES DOWN and CENTRAL STOCK GOES UP. There is no
 *                       GRN and no PO — see the auto-fill note below.
 *
 * Requirement 76's words — "added back to Store stock" — describe the INTERNAL
 * shape and only the internal shape. A vendor return that credited central
 * would invent inventory that is physically on a lorry back to the supplier.
 * The two flows below therefore share components but never share a submit.
 *
 * ── WHY THE VENDOR FLOW MAKES YOU PICK A GRN LINE ─────────────────────────
 * Requirement 72 asks for PO No. and GRN No. to be auto-filled, and the
 * tempting reading is "pick the material, look up its GRN". Measured on the
 * live database: Sugar alone arrived on FIVE GRNs, four of them ad-hoc with no
 * PO at all and rates from ₹10 to ₹200. Defaulting to the newest would file a
 * credit note twenty times wrong against a purchase order the goods never came
 * in on. So the picker lists the GRN LINES and the user chooses one; the PO
 * No., GRN No., vendor and rate then follow from that choice and are never
 * guessed. A GRN with no PO prints its PO No. BLANK — a blank is honest, a
 * nearest match ends up on a supplier's credit note.
 *
 * One ticket, one GRN. The header carries a single grn_id, so switching GRN
 * clears the lines rather than quietly filing half of them under the wrong
 * receipt.
 *
 * ── WHY THE INTERNAL FLOW SHOWS "never counted" AND NOT 0 ─────────────────
 * dept-stock settled this and this page repeats it rather than re-deciding: a
 * (department, material) pair with no closing count and no cutover opening row
 * has on_hand NULL, not 0. A plausible wrong number is worse than a blank, and
 * the returnable figure beside it falls back to the signed ledger sum — which
 * is exactly what the Accept guard falls back to, so the screen and the mover
 * agree about what can be given back.
 *
 * ── UNITS ─────────────────────────────────────────────────────────────────
 * Owner rule: every Purchase / Inventory figure LEADS with the PURCHASE unit
 * (kg / L / BTL), with the recipe figure as a small declared hint. Entry is in
 * the purchase unit too, and the line is POSTED in that unit — the server
 * converts once, at the boundary, and SNAPSHOTS the factor onto the row. The
 * pack rule is never re-derived here: pack_factor comes off the wire already
 * both-halves guarded (pack_size > 1 AND recipe unit ≠ purchase unit), so
 * PICKLED GINGER 1.5KG (kg / kg / 1.5) correctly converts by 1.
 *
 * ── WHAT THIS PAGE DELIBERATELY DOES NOT DO ───────────────────────────────
 * It does not approve, verify, accept or reject. Those are the ticket page's
 * job and the server's gates (canApproveAsChef, canIssueAsStore). The row
 * badges below are read from the list API's own per-row hints so the screen
 * cannot invent a permission the server would refuse.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Undo2, Truck, Store, Plus, X, Search, Loader2, AlertTriangle, Info,
  Trash2, CheckCircle2, Clock, ShieldCheck, Ban, FileText, RefreshCw,
  Building2, PackageOpen,
} from 'lucide-react';
import { api } from '@/lib/api';
import Qty from '@/components/Qty';
import TabScroller from '@/components/TabScroller';
import { dualQty, fmtQtyNum, type DualQty, type PackMeta } from '@/lib/pack-units';

/* ────────────────────────────────────────────────────────────────────────────
 * WIRE SHAPES — what /api/returns and /api/returns/sources actually send.
 * ──────────────────────────────────────────────────────────────────────────── */

interface ReturnRow {
  id: string;
  ret_number: string;
  kind: 'internal' | 'vendor';
  date: string;
  status: string;
  department_id: string | null;
  department_name: string | null;
  department_code: string | null;
  grn_id: string | null;
  grn_number: string | null;
  po_id: string | null;
  po_number: string | null;
  vendor: string;
  credit_note_no: string;
  credit_note_amount: number;
  notes: string;
  drafted_by: string;
  item_count: number;
  lines_written_off: number;
  can_submit: boolean;
  can_hod_approve: boolean;
  can_store_verify: boolean;
  can_cancel: boolean;
}

/** One GRN LINE the vendor flow can be anchored on. All quantities PURCHASE units. */
interface VendorSource {
  grn_item_id: string;
  grn_id: string;
  grn_number: string;
  grn_date: string;
  invoice_number: string;
  po_item_id: string;
  po_id: string;
  /** '' for the ad-hoc GRNs that have no purchase order. Print it blank. */
  po_number: string;
  vendor_id: string;
  vendor: string;
  material_id: string;
  material_name: string;
  unit: string;
  purchase_unit: string;
  pack_factor: number;
  quantity_accepted: number;
  already_returned_qty: number;
  remaining_qty: number;
  /** Rs per PURCHASE unit, straight off this GRN line. */
  unit_price: number;
  display: {
    accepted: { primary: string; hint: string | null };
    already_returned: { primary: string; hint: string | null };
    remaining: { primary: string; hint: string | null };
  };
  window_open: boolean;
  window_note: string;
}

/** One material a department could give back. on_hand / returnable are RECIPE units. */
interface InternalSource {
  material_id: string;
  material_name: string;
  category: string;
  unit: string;
  purchase_unit: string;
  pack_size: number;
  pack_factor: number;
  on_hand: number | null;
  never_counted: boolean;
  movements_since: number;
  returnable: number;
  returnable_exact: boolean;
  can_return: boolean;
  qty: DualQty;
  display: { primary: string; hint: string | null };
}

interface DeptRow { id: string; name: string; code?: string; parent_id: string | null; is_active: number; }

/**
 * A line in the composer's cart. `qty` is kept as the RAW string — running it
 * through Number() on every keystroke eats the decimal point ("2." → "2").
 * It is in PURCHASE units, and `unit` (the purchase unit) is what gets POSTed
 * alongside it so the server converts with the right factor.
 */
interface DraftLine {
  key: string;
  material_id: string;
  material_name: string;
  /** Recipe unit — the hint basis only. */
  recipe_unit: string;
  /** Purchase unit — what the user types in and what we POST as `unit`. */
  unit: string;
  /** Recipe units per purchase unit, already both-halves guarded server-side. */
  pack_factor: number;
  qty: string;
  reason: string;
  disposition: 'reusable' | 'wastage' | 'disposal';
  notes: string;
  /** Vendor anchor — absent on internal lines. */
  grn_item_id?: string;
  po_item_id?: string;
  grn_number?: string;
  po_number?: string;
  /** Rs per PURCHASE unit (vendor lines only). */
  unit_price?: number;
  /** Ceiling in PURCHASE units, for the client-side warning only. The Accept re-checks. */
  max_purchase: number;
  max_label: string;
  never_counted?: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
 * SMALL SHARED BITS
 * ──────────────────────────────────────────────────────────────────────────── */

const todayISO = () => new Date().toISOString().slice(0, 10);
/** A thrown value narrowed to a message, so a network blip never renders "[object Object]". */
const errText = (e: unknown) => (e instanceof Error ? e.message : '');
const money = (v: number) => '₹' + Math.round(Number(v) || 0).toLocaleString('en-IN');
const newKey = () => Math.random().toString(36).slice(2, 10);

const STATUS_META: Record<string, { label: string; tone: string }> = {
  draft:        { label: 'Draft',              tone: 'bg-[#E8D5C4] text-[#6B5744]' },
  submitted:    { label: 'Awaiting HOD',       tone: 'bg-amber-100 text-amber-800' },
  hod_approved: { label: 'At Store',           tone: 'bg-blue-100 text-blue-800' },
  verified:     { label: 'Verified',           tone: 'bg-emerald-100 text-emerald-800' },
  hod_rejected: { label: 'Rejected by HOD',    tone: 'bg-red-100 text-red-700' },
  cancelled:    { label: 'Cancelled',          tone: 'bg-gray-100 text-gray-600' },
};

/**
 * The disposition selector's plain language. Requirement 78 is a WRITE-OFF, and
 * the one thing a storekeeper must not misunderstand is that a written-off line
 * never becomes sellable stock again — the department is debited and nobody is
 * credited. Saying it in the option's own help text is cheaper than explaining
 * it after the fact.
 */
const DISPOSITIONS = [
  {
    v: 'reusable' as const,
    label: 'Reusable',
    help: 'Still good. On Store Accept it goes back into store stock — department stock down, store stock up.',
    tone: 'text-emerald-700',
  },
  {
    v: 'wastage' as const,
    label: 'Wastage',
    help: 'Unusable (spoiled, expired, damaged). Written off the department on Accept. It does NOT go back into sellable store stock.',
    tone: 'text-amber-700',
  },
  {
    v: 'disposal' as const,
    label: 'Disposal',
    help: 'Destroyed / thrown away. Written off the department on Accept. It does NOT go back into sellable store stock.',
    tone: 'text-red-700',
  },
];

function StatusPill({ status }: { status: string }) {
  const m = STATUS_META[status] || { label: status, tone: 'bg-[#E8D5C4] text-[#6B5744]' };
  return <span className={`text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap ${m.tone}`}>{m.label}</span>;
}

function KindPill({ kind }: { kind: 'internal' | 'vendor' }) {
  return kind === 'vendor'
    ? (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-800 inline-flex items-center gap-1 whitespace-nowrap"
            title="Goods go back to the supplier — on Store Accept, central stock goes DOWN">
        <Truck className="w-3 h-3" /> Vendor
      </span>
    )
    : (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800 inline-flex items-center gap-1 whitespace-nowrap"
            title="Goods come back from a department — on Store Accept, department stock goes DOWN and central stock goes UP">
        <Store className="w-3 h-3" /> To Store
      </span>
    );
}

/** The one sentence that has to be true on every surface in this module. */
function StockMovesNotice({ kind }: { kind: 'internal' | 'vendor' }) {
  return (
    <div className="flex items-start gap-2 text-[11px] bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg px-3 py-2 text-[#6B5744]">
      <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[#af4408]" />
      <span>
        <b>No stock moves until the Store accepts this ticket.</b> Raising it, and the HOD approving it,
        move nothing.{' '}
        {kind === 'vendor'
          ? <>On Accept the goods leave the building and <b>central store stock goes DOWN</b>. The credit note below is recorded only — it never touches stock or costing.</>
          : <>On Accept <b>department stock goes DOWN and central store stock goes UP</b> — the goods never leave the building.</>}
      </span>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE PAGE — queue + the two raise buttons
 * ──────────────────────────────────────────────────────────────────────────── */

type TabKey = 'all' | 'draft' | 'submitted' | 'hod_approved' | 'verified' | 'closed';

export default function ReturnsPage() {
  const [rows, setRows] = useState<ReturnRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<TabKey>('all');
  const [kindFilter, setKindFilter] = useState<'' | 'internal' | 'vendor'>('');
  const [search, setSearch] = useState('');
  const [composer, setComposer] = useState<null | 'vendor' | 'internal'>(null);
  // What this viewer may RAISE, decided by the server (GET /api/returns) from
  // the same predicates POST enforces.
  //
  // NULL MEANS NOT YET KNOWN, and both doors stay shut while it is. Defaulting
  // to {true,true} was the obvious choice and the wrong one: the flags are only
  // written on the success path, so every page load enabled both above-the-fold
  // buttons until the fetch returned, and a failed first load left them enabled
  // for the life of the page. Either window hands back exactly the
  // offer-then-reject this change exists to remove. A shut door for one fetch is
  // the cheaper mistake, and it is honest — we genuinely do not know yet.
  //
  // An older server that does not send these fields still reads as permitted
  // (`!== false`), so a rolling deploy never hides a door someone really has.
  const [canRaise, setCanRaise] = useState<{ vendor: boolean; internal: boolean } | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/returns');
      const j = await r.json();
      if (!r.ok) { setErr(j.error || 'Could not load returns'); setRows([]); return; }
      setErr('');
      setRows(j.returns || []);
      const raise = {
        vendor: j.viewer_can_raise_vendor !== false,
        internal: j.viewer_can_raise_internal !== false,
      };
      setCanRaise(raise);
      // Re-gate a composer that is ALREADY OPEN. The flags can arrive after the
      // sheet does (a slow first load, or a background refresh), and a sheet
      // left open on a kind the viewer may not raise would still let them fill
      // it in and be refused on save.
      setComposer((c) => (c && !raise[c] ? null : c));
    } catch (e) {
      setErr(errText(e) || 'Could not load returns');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const matchesTab = (r: ReturnRow, k: TabKey) => {
    if (k === 'all') return true;
    if (k === 'closed') return r.status === 'hod_rejected' || r.status === 'cancelled';
    return r.status === k;
  };

  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (kindFilter && r.kind !== kindFilter) return false;
      if (!q) return true;
      return [r.ret_number, r.department_name, r.vendor, r.grn_number, r.po_number, r.drafted_by, r.notes]
        .some(v => String(v || '').toLowerCase().includes(q));
    });
  }, [rows, search, kindFilter]);

  const shown = useMemo(() => searched.filter(r => matchesTab(r, tab)), [searched, tab]);

  // The two counts a queue exists for. Counted off the SAME predicate the tab
  // body filters with, so a badge can never promise rows the tab will not show.
  const pendingApproval = searched.filter(r => matchesTab(r, 'submitted')).length;
  const pendingVerify   = searched.filter(r => matchesTab(r, 'hod_approved')).length;

  return (
    <div className="p-3 sm:p-6 max-w-7xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <Undo2 className="w-6 h-6 text-[#af4408]" /> Material Returns
          </h1>
          <p className="text-xs text-[#6B5744] mt-1 max-w-3xl">
            Raise a return, get it approved by the Department Head, and hand it to the Store.{' '}
            <b>Stock only moves when the Store accepts it</b> — a rejected line leaves stock exactly where it was.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={reload}
                  className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>
      </div>

      {/* THE TWO DOORS. The kind is decided here, by which one you walk through —
          not by a dropdown inside a form, because the two do opposite things to
          central stock and a mis-set dropdown on an otherwise-complete ticket is
          how inventory gets invented. */}
      {/* DISABLED, NOT HIDDEN, when this viewer may not raise that kind. A door
          that vanishes reads as a bug and becomes a phone call ("where did
          Return to Store go?"); a door that is visibly shut and says why is
          answerable on the spot. The server refuses either way — this only
          stops the page inviting work it will then reject at the last click. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <button onClick={() => setComposer('vendor')}
                disabled={canRaise?.vendor !== true}
                title={canRaise == null ? 'Checking your permissions…' : canRaise.vendor ? undefined : 'Only the store or an admin can raise a vendor return'}
                className="text-left bg-white border border-[#E8D5C4] rounded-xl p-4 transition enabled:hover:border-rose-300 enabled:hover:bg-rose-50/40 disabled:opacity-60 disabled:cursor-not-allowed">
          <div className="flex items-center gap-2 text-[#2D1B0E] font-semibold text-sm">
            <Truck className="w-4 h-4 text-rose-600" /> Return to Vendor
            {canRaise?.vendor === true && <Plus className="w-3.5 h-3.5 ml-auto text-[#8B7355]" />}
          </div>
          <p className="text-[11px] text-[#6B5744] mt-1">
            Goods go back to the supplier. Pick the <b>GRN line</b> they arrived on — PO No., GRN No.,
            vendor and rate come from that line. On Store Accept, <b>central stock goes DOWN</b>.
          </p>
          {canRaise?.vendor === false && (
            <p className="text-[11px] text-[#8B7355] mt-1.5 italic">
              Raised at the receiving counter — the store or an admin.
            </p>
          )}
        </button>
        <button onClick={() => setComposer('internal')}
                disabled={canRaise?.internal !== true}
                title={canRaise == null ? 'Checking your permissions…' : canRaise.internal ? undefined : 'Your user has no department assigned'}
                className="text-left bg-white border border-[#E8D5C4] rounded-xl p-4 transition enabled:hover:border-indigo-300 enabled:hover:bg-indigo-50/40 disabled:opacity-60 disabled:cursor-not-allowed">
          <div className="flex items-center gap-2 text-[#2D1B0E] font-semibold text-sm">
            <Store className="w-4 h-4 text-indigo-600" /> Return to Store
            {canRaise?.internal === true && <Plus className="w-3.5 h-3.5 ml-auto text-[#8B7355]" />}
          </div>
          <p className="text-[11px] text-[#6B5744] mt-1">
            A department gives issued items back. Pick the department, then items from what it
            actually holds. On Store Accept, <b>department stock goes DOWN and central stock goes UP</b>.
          </p>
          {canRaise?.internal === false && (
            <p className="text-[11px] text-[#8B7355] mt-1.5 italic">
              Raised by the department returning the goods. Ask an admin to set your department.
            </p>
          )}
        </button>
      </div>

      {/* Queue tabs */}
      <TabScroller className="gap-2 text-xs">
        {([
          { k: 'all',          label: 'All',                  icon: FileText,     tone: 'stone' },
          { k: 'draft',        label: 'Drafts',               icon: PackageOpen,  tone: 'stone' },
          { k: 'submitted',    label: 'Awaiting HOD',         icon: Clock,        tone: 'amber' },
          { k: 'hod_approved', label: 'Awaiting Store',       icon: ShieldCheck,  tone: 'blue' },
          { k: 'verified',     label: 'Verified',             icon: CheckCircle2, tone: 'emerald' },
          { k: 'closed',       label: 'Rejected / Cancelled', icon: Ban,          tone: 'rose' },
        ] as const).map(t => {
          const n = searched.filter(r => matchesTab(r, t.k)).length;
          const active = tab === t.k;
          const onStyle: Record<string, string> = {
            stone:   active ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E8D5C4]',
            amber:   active ? 'bg-amber-600 text-white border-amber-600' : 'bg-amber-50 text-amber-800 border-amber-200',
            blue:    active ? 'bg-blue-600 text-white border-blue-600'   : 'bg-blue-50 text-blue-800 border-blue-200',
            emerald: active ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-emerald-50 text-emerald-800 border-emerald-200',
            rose:    active ? 'bg-rose-600 text-white border-rose-600'   : 'bg-rose-50 text-rose-800 border-rose-200',
          };
          const Icon = t.icon;
          return (
            <button key={t.k} onClick={() => setTab(t.k)}
                    className={`px-3 py-1.5 rounded border flex items-center gap-1.5 ${onStyle[t.tone]}`}>
              <Icon className="w-3.5 h-3.5" /> {t.label} <span className="font-mono">{n}</span>
            </button>
          );
        })}
      </TabScroller>

      {/* The two numbers the queue exists for, said in words as well as badges. */}
      {(pendingApproval > 0 || pendingVerify > 0) && (
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-[#6B5744]">
          {pendingApproval > 0 && (
            <span className="inline-flex items-center gap-1.5 bg-amber-50 border border-amber-200 text-amber-800 rounded px-2 py-1">
              <Clock className="w-3.5 h-3.5" /> <b className="font-mono">{pendingApproval}</b> waiting on Department Head approval
            </span>
          )}
          {pendingVerify > 0 && (
            <span className="inline-flex items-center gap-1.5 bg-blue-50 border border-blue-200 text-blue-800 rounded px-2 py-1">
              <ShieldCheck className="w-3.5 h-3.5" /> <b className="font-mono">{pendingVerify}</b> waiting on Store verification
              <span className="text-blue-700/70">— stock moves there</span>
            </span>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 bg-white border border-[#E8D5C4] rounded-xl p-3">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="w-4 h-4 absolute left-2 top-2 text-[#8B7355]" />
          <input value={search} onChange={e => setSearch(e.target.value)}
                 placeholder="Search ticket no. / department / vendor / GRN / PO / raised by…"
                 className="w-full pl-8 pr-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0]" />
        </div>
        <TabScroller className="gap-1.5 text-[11px]">
          {([
            { v: '' as const,         label: 'Both kinds' },
            { v: 'vendor' as const,   label: 'To Vendor' },
            { v: 'internal' as const, label: 'To Store' },
          ]).map(k => (
            <button key={k.v || 'both'} onClick={() => setKindFilter(k.v)}
                    className={`px-2.5 py-1 rounded border ${kindFilter === k.v
                      ? 'bg-[#af4408] text-white border-[#af4408]'
                      : 'bg-white text-[#6B5744] border-[#E8D5C4]'}`}>
              {k.label}
            </button>
          ))}
        </TabScroller>
      </div>

      {err && (
        <div className="flex items-start gap-2 text-xs bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {err}
        </div>
      )}

      {/* Queue */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-[#8B7355]">
            <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
          </div>
        ) : shown.length === 0 ? (
          <div className="p-8 text-center text-sm text-[#8B7355]">
            No return tickets here yet. Use <b>Return to Vendor</b> or <b>Return to Store</b> above to raise one.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[840px]">
              <thead className="bg-[#FFF1E3] text-[#6B5744]">
                <tr>
                  <th className="text-left  py-1.5 px-3 font-medium">Ticket</th>
                  <th className="text-left  py-1.5 px-3 font-medium">Kind</th>
                  <th className="text-left  py-1.5 px-3 font-medium">Date</th>
                  <th className="text-left  py-1.5 px-3 font-medium">From / To</th>
                  <th className="text-left  py-1.5 px-3 font-medium">PO No.</th>
                  <th className="text-left  py-1.5 px-3 font-medium">GRN No.</th>
                  <th className="text-right py-1.5 px-3 font-medium">Lines</th>
                  <th className="text-left  py-1.5 px-3 font-medium">Status</th>
                  <th className="text-left  py-1.5 px-3 font-medium">Raised by</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(r => (
                  <tr key={r.id} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0]">
                    <td className="py-1.5 px-3">
                      <Link href={`/returns/${r.id}`} className="font-mono font-semibold text-[#af4408] hover:underline">
                        {r.ret_number}
                      </Link>
                    </td>
                    <td className="py-1.5 px-3"><KindPill kind={r.kind} /></td>
                    <td className="py-1.5 px-3 whitespace-nowrap">{r.date}</td>
                    <td className="py-1.5 px-3">
                      {r.kind === 'vendor'
                        ? <span>{r.vendor || <span className="text-[#B8A590]">—</span>}</span>
                        : <span>{r.department_name || <span className="text-[#B8A590]">—</span>}</span>}
                    </td>
                    {/* BLANK, never a nearest match: 9 of the live GRNs have no PO at all,
                        and an internal return has no purchase chain to walk back to. */}
                    <td className="py-1.5 px-3 font-mono text-[11px]">
                      {r.po_number || <span className="text-[#B8A590]">—</span>}
                    </td>
                    <td className="py-1.5 px-3 font-mono text-[11px]">
                      {r.grn_number || <span className="text-[#B8A590]">—</span>}
                    </td>
                    <td className="py-1.5 px-3 text-right font-mono">
                      {r.item_count}
                      {r.lines_written_off > 0 && (
                        <div className="text-[9px] text-amber-700">{r.lines_written_off} written off</div>
                      )}
                    </td>
                    <td className="py-1.5 px-3"><StatusPill status={r.status} /></td>
                    <td className="py-1.5 px-3 text-[10px] text-[#8B7355]">{r.drafted_by || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {composer === 'vendor' && (
        <VendorComposer onClose={() => setComposer(null)} onSaved={() => { setComposer(null); reload(); }} />
      )}
      {composer === 'internal' && (
        <InternalComposer onClose={() => setComposer(null)} onSaved={() => { setComposer(null); reload(); }} />
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * SHARED COMPOSER CHROME
 * ──────────────────────────────────────────────────────────────────────────── */

function Sheet({ title, subtitle, tone, onClose, children, footer }: {
  title: string;
  subtitle: string;
  tone: string;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center sm:justify-center p-0 sm:p-4">
      <div className="bg-[#FFF8F0] w-full sm:max-w-5xl sm:rounded-2xl rounded-t-2xl max-h-[95vh] sm:max-h-[90vh] flex flex-col overflow-hidden">
        <div className={`px-4 py-3 flex items-start gap-3 border-b border-[#E8D5C4] ${tone}`}>
          {/* flex-1 min-w-0 is load-bearing at 375px: without it the two-line
              subtitle pushes the close button onto its own row. */}
          <div className="flex-1 min-w-0">
            <h2 className="text-sm sm:text-base font-bold text-[#2D1B0E]">{title}</h2>
            <p className="text-[11px] text-[#6B5744] mt-0.5">{subtitle}</p>
          </div>
          <button onClick={onClose} className="shrink-0 p-1 rounded hover:bg-black/5 text-[#6B5744]" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3">{children}</div>
        {/* pl-16 on phones keeps the action row clear of the app's floating
            notification bell, which parks itself bottom-left over everything. */}
        <div className="border-t border-[#E8D5C4] bg-white p-3 pl-16 sm:pl-3 flex flex-wrap items-center justify-end gap-2">
          {footer}
        </div>
      </div>
    </div>
  );
}

/**
 * The per-line editor, shared by both flows because the fields ARE the same —
 * quantity in the purchase unit, a MANDATORY reason (requirement 72), and a
 * disposition (requirement 78). What differs is locked by props, not by a
 * runtime flag the caller could get wrong: a vendor line has no disposition
 * choice at all, because the goods physically go back to the supplier and the
 * server refuses any write-off on that kind.
 */
function LineEditor({ line, allowDisposition, onChange, onRemove, showReasonError }: {
  line: DraftLine;
  allowDisposition: boolean;
  onChange: (patch: Partial<DraftLine>) => void;
  onRemove: () => void;
  showReasonError: boolean;
}) {
  const typed = parseFloat(line.qty) || 0;
  const converts = line.pack_factor > 1;
  const over = line.max_purchase > 0 && typed > line.max_purchase + 1e-9;
  const disp = DISPOSITIONS.find(d => d.v === line.disposition)!;
  const reasonMissing = !line.reason.trim();

  return (
    <div className="border border-[#E8D5C4] rounded-lg bg-white p-3 space-y-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[#2D1B0E] truncate">{line.material_name}</div>
          <div className="text-[10px] text-[#8B7355] flex flex-wrap gap-x-3">
            {line.grn_number && <span>GRN <span className="font-mono">{line.grn_number}</span></span>}
            {line.grn_number && (
              <span>PO <span className="font-mono">{line.po_number || '—'}</span></span>
            )}
            {/* rate-basis: purchase — unit_price is ₹ per PURCHASE unit, straight off
                the chosen GRN line, and it is displayed against a purchase-unit
                quantity. Nothing here re-bases it and last_purchase_price is never read. */}
            {typeof line.unit_price === 'number' && (
              <span>Rate <span className="font-mono">{money(line.unit_price)}</span> / {line.unit}</span>
            )}
            <span>{line.max_label}</span>
          </div>
        </div>
        <button onClick={onRemove} className="text-red-600 hover:text-red-800 p-1" title="Remove line">
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 text-xs">
        <label className="flex flex-col gap-1 text-[#6B5744] sm:col-span-3">
          <span>Quantity ({line.unit})</span>
          {/* Keep the RAW string — Number() on every keystroke eats the decimal
              point. Entry is in the PURCHASE unit and the line is POSTed in that
              unit; the server converts once and snapshots the factor. */}
          <input type="number" step="any" min="0" inputMode="decimal"
                 value={line.qty}
                 onChange={e => onChange({ qty: e.target.value.replace(/^-+/, '') })}
                 className={`px-2 py-1.5 border rounded bg-[#FFF8F0] font-mono ${over ? 'border-red-400' : 'border-[#E8D5C4]'}`} />
          {converts && (
            <span className="text-[9px] text-[#B8A590]">= {fmtQtyNum(typed * line.pack_factor)} {line.recipe_unit}</span>
          )}
          {over && (
            <span className="text-[10px] text-red-600">More than {line.max_label.toLowerCase()}</span>
          )}
        </label>

        <label className="flex flex-col gap-1 text-[#6B5744] sm:col-span-5">
          <span>Reason <span className="text-red-600">*</span></span>
          <input value={line.reason} onChange={e => onChange({ reason: e.target.value })}
                 placeholder="Why is this going back? e.g. wrong item supplied, excess issued, poor quality"
                 className={`px-2 py-1.5 border rounded bg-[#FFF8F0] ${showReasonError && reasonMissing ? 'border-red-400' : 'border-[#E8D5C4]'}`} />
          {showReasonError && reasonMissing && (
            <span className="text-[10px] text-red-600">A reason is required on every line.</span>
          )}
        </label>

        {allowDisposition ? (
          <label className="flex flex-col gap-1 text-[#6B5744] sm:col-span-4">
            <span>Condition</span>
            <select value={line.disposition}
                    onChange={e => onChange({ disposition: e.target.value as DraftLine['disposition'] })}
                    className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]">
              {DISPOSITIONS.map(d => <option key={d.v} value={d.v}>{d.label}</option>)}
            </select>
            <span className={`text-[10px] leading-snug ${disp.tone}`}>{disp.help}</span>
          </label>
        ) : (
          <div className="flex flex-col gap-1 text-[#6B5744] sm:col-span-4">
            <span>Condition</span>
            <div className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#F3EAE0] text-[#8B7355]">Reusable</div>
            <span className="text-[10px] text-[#8B7355] leading-snug">
              A vendor return cannot be written off here — the goods go back to the supplier.
              To write stock off, raise a <b>Return to Store</b> or use the Wastage screen.
            </span>
          </div>
        )}
      </div>

      <input value={line.notes} onChange={e => onChange({ notes: e.target.value })}
             placeholder="Notes (optional)"
             className="w-full px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-xs" />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * VENDOR FLOW — requirement 72. Anchored on a GRN LINE, never on a material.
 * ──────────────────────────────────────────────────────────────────────────── */

function VendorComposer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [search, setSearch] = useState('');
  const [sources, setSources] = useState<VendorSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [pickerErr, setPickerErr] = useState('');
  const [truncated, setTruncated] = useState(false);

  const [date, setDate] = useState(todayISO());
  const [lines, setLines] = useState<DraftLine[]>([]);
  /** ONE ticket, ONE GRN — the header carries a single grn_id. */
  const [anchor, setAnchor] = useState<VendorSource | null>(null);
  const [creditNo, setCreditNo] = useState('');
  const [creditDate, setCreditDate] = useState('');
  const [creditAmount, setCreditAmount] = useState('');
  const [notes, setNotes] = useState('');

  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const [touched, setTouched] = useState(false);

  // Debounced picker load. Nothing here reserves anything — see the page header.
  useEffect(() => {
    let dead = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ mode: 'vendor' });
        if (search.trim()) qs.set('search', search.trim());
        const r = await fetch(`/api/returns/sources?${qs}`);
        const j = await r.json();
        if (dead) return;
        if (!r.ok) { setPickerErr(j.error || 'Could not load GRN lines'); setSources([]); return; }
        setPickerErr('');
        setSources(j.rows || []);
        setTruncated(!!j.truncated);
      } catch (e) {
        if (!dead) setPickerErr(errText(e) || 'Could not load GRN lines');
      } finally {
        if (!dead) setLoading(false);
      }
    }, 250);
    return () => { dead = true; clearTimeout(t); };
  }, [search]);

  const addLine = (s: VendorSource) => {
    // Switching GRN clears the cart rather than filing half the lines under the
    // wrong receipt: the ticket header holds exactly one grn_id, so a mixed cart
    // could only be saved by lying about where some of the goods came from.
    if (anchor && anchor.grn_id !== s.grn_id) {
      const ok = confirm(
        `This ticket is anchored to GRN ${anchor.grn_number}`
        + `${anchor.po_number ? ` (PO ${anchor.po_number})` : ' (no PO)'}.\n\n`
        + `Switch to GRN ${s.grn_number}${s.po_number ? ` (PO ${s.po_number})` : ' (no PO)'} and clear the `
        + `${lines.length} line(s) already added?`,
      );
      if (!ok) return;
      setLines([]);
    }
    if (lines.some(l => l.grn_item_id === s.grn_item_id)) return;
    setAnchor(s);
    setLines(prev => [...prev, {
      key: newKey(),
      material_id: s.material_id,
      material_name: s.material_name,
      recipe_unit: s.unit,
      unit: s.purchase_unit || s.unit,
      pack_factor: s.pack_factor,
      qty: '',
      reason: '',
      disposition: 'reusable',
      notes: '',
      grn_item_id: s.grn_item_id,
      po_item_id: s.po_item_id,
      grn_number: s.grn_number,
      po_number: s.po_number,
      unit_price: s.unit_price,
      // remaining_qty is already PURCHASE units on the wire (quantity_accepted
      // canon) — it must NOT be divided by the pack factor a second time.
      max_purchase: s.remaining_qty,
      max_label: `${s.display.remaining.primary} returnable`,
    }]);
  };

  const patch = (key: string, p: Partial<DraftLine>) =>
    setLines(prev => prev.map(l => (l.key === key ? { ...l, ...p } : l)));
  const remove = (key: string) => {
    setLines(prev => {
      const next = prev.filter(l => l.key !== key);
      if (next.length === 0) setAnchor(null);
      return next;
    });
  };

  const blankReason = lines.some(l => !l.reason.trim());
  const blankQty    = lines.some(l => !(parseFloat(l.qty) > 0));
  const canSave     = lines.length > 0 && !blankReason && !blankQty && !!anchor;

  // rate-basis: purchase — ₹/PURCHASE unit × a PURCHASE-unit quantity. This is
  // an EXPECTED CREDIT shown to help fill the credit-note field; it is never
  // posted as a price, never touches average_price, and never writes a negative
  // purchases row (which would become THE price on the FIFO branch and cascade
  // into every recipe cost).
  const expectedCredit = lines.reduce(
    (s, l) => s + (Number(l.unit_price) || 0) * (parseFloat(l.qty) || 0), 0,
  );

  const save = async (thenSubmit: boolean) => {
    setTouched(true);
    if (!canSave) return;
    setSaving(true); setSaveErr('');
    try {
      const res = await api('/api/returns', {
        method: 'POST',
        body: {
          kind: 'vendor',
          date,
          grn_id: anchor!.grn_id,
          credit_note_no: creditNo,
          credit_note_date: creditDate,
          credit_note_amount: parseFloat(creditAmount) || 0,
          notes,
          items: lines.map(l => ({
            material_id: l.material_id,
            grn_item_id: l.grn_item_id,
            po_item_id: l.po_item_id,
            quantity: parseFloat(l.qty) || 0,
            // The PURCHASE unit, because that is the basis the box was typed in.
            unit: l.unit,
            reason: l.reason.trim(),
            disposition: 'reusable',
            notes: l.notes,
          })),
        },
      });
      const j = await res.json();
      if (!res.ok) { setSaveErr(j.error || 'Could not save the return'); return; }
      if (thenSubmit && j?.return?.id) {
        const sr = await api(`/api/returns/${j.return.id}/submit`, { method: 'POST', body: {} });
        if (!sr.ok) {
          const sj = await sr.json().catch(() => ({}));
          setSaveErr(`Saved as draft ${j.return.ret_number}, but could not submit: ${sj.error || 'unknown error'}`);
          return;
        }
      }
      onSaved();
    } catch (e) {
      setSaveErr(errText(e) || 'Could not save the return');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      title="Return to Vendor"
      subtitle="Pick the GRN line the goods arrived on. PO No., GRN No., vendor and rate come from that line — nothing is guessed."
      tone="bg-rose-50"
      onClose={onClose}
      footer={
        <>
          <div className="text-[11px] text-[#6B5744] w-full sm:w-auto sm:mr-auto">
            {lines.length} line(s)
            {blankReason && <span className="text-red-600"> · a reason is required on every line</span>}
            {!blankReason && blankQty && <span className="text-red-600"> · every line needs a quantity</span>}
          </div>
          <button onClick={onClose} className="px-3 py-2 text-sm border border-[#E8D5C4] rounded-lg bg-white text-[#6B5744]">
            Cancel
          </button>
          <button onClick={() => save(false)} disabled={saving || !canSave}
                  className="px-3 py-2 text-sm border border-[#E8D5C4] rounded-lg bg-white text-[#6B5744] disabled:opacity-50">
            <span className="hidden sm:inline">Save draft</span><span className="sm:hidden">Draft</span>
          </button>
          <button onClick={() => save(true)} disabled={saving || !canSave}
                  className="px-3 py-2 text-sm rounded-lg bg-rose-600 hover:bg-rose-700 text-white flex items-center gap-1.5 disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Undo2 className="w-4 h-4" />}
            <span className="hidden sm:inline">Save &amp; send for approval</span><span className="sm:hidden">Send</span>
          </button>
        </>
      }
    >
      <StockMovesNotice kind="vendor" />

      {anchor && (
        <div className="bg-white border border-rose-200 rounded-lg p-3 text-xs">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
            <span className="text-[#6B5744]">Anchored to</span>
            <span><b className="font-mono">{anchor.grn_number}</b> <span className="text-[#8B7355]">GRN</span></span>
            {/* Blank when the goods came in ad-hoc. Never a nearest match. */}
            <span>
              <b className="font-mono">{anchor.po_number || '—'}</b> <span className="text-[#8B7355]">PO</span>
              {!anchor.po_number && <span className="text-[10px] text-[#B8A590] ml-1">(ad-hoc receipt, no PO)</span>}
            </span>
            <span>{anchor.vendor || <span className="text-[#B8A590]">no vendor on the GRN</span>}</span>
            <span className="text-[#8B7355]">{anchor.grn_date}</span>
          </div>
          <div className="text-[10px] text-[#8B7355] mt-1">
            One ticket, one GRN — picking a line from a different GRN starts the ticket again.
          </div>
        </div>
      )}

      {/* GRN LINE picker */}
      <div className="bg-white border border-[#E8D5C4] rounded-lg">
        <div className="p-3 border-b border-[#E8D5C4] flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-2 top-2 text-[#8B7355]" />
            <input value={search} onChange={e => setSearch(e.target.value)}
                   placeholder="Search material / GRN no. / PO no. / vendor / invoice…"
                   className="w-full pl-8 pr-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0]" />
          </div>
          {loading && <Loader2 className="w-4 h-4 animate-spin text-[#8B7355]" />}
        </div>

        {pickerErr && (
          <div className="p-3 text-xs text-red-700 bg-red-50 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {pickerErr}
          </div>
        )}

        <div className="max-h-[300px] overflow-y-auto">
          {!pickerErr && sources.length === 0 && !loading && (
            <div className="p-6 text-center text-xs text-[#8B7355]">
              No GRN lines match. A line disappears from here once its whole received quantity has already come back.
            </div>
          )}
          {/* A reflowing grid, NOT a min-width table. A picker whose Add button sits
              behind a horizontal scroll is unusable on a 375px phone — the storekeeper
              cannot press the only control the row has. Columns line up on sm+ and
              stack on a phone. */}
          <div className="text-xs">
            {sources.map(s => {
              const already = lines.some(l => l.grn_item_id === s.grn_item_id);
              const otherGrn = !!anchor && anchor.grn_id !== s.grn_id;
              return (
                <div key={s.grn_item_id}
                     className={`border-t border-[#E8D5C4]/50 px-3 py-2 grid grid-cols-2 sm:grid-cols-[1.4fr_auto_auto_auto_auto] gap-x-3 gap-y-1 items-center
                                 ${otherGrn ? 'opacity-50' : ''} hover:bg-[#FFF8F0]`}>
                  <div className="col-span-2 sm:col-span-1 min-w-0">
                    <div className="font-medium text-[#2D1B0E]">{s.material_name}</div>
                    <div className="text-[10px] text-[#8B7355]">
                      {s.vendor || 'no vendor'} · {s.grn_date}
                      {s.invoice_number && <> · inv <span className="font-mono">{s.invoice_number}</span></>}
                    </div>
                  </div>
                  <div className="font-mono text-[11px] whitespace-nowrap">
                    <div>{s.grn_number}</div>
                    {/* The acceptance test lives here: two GRNs of the same material
                        show DIFFERENT PO numbers and DIFFERENT rates, and the ticket
                        takes whichever the user actually clicks. */}
                    <div className="text-[10px] text-[#8B7355]">{s.po_number || 'no PO'}</div>
                  </div>
                  {/* PURCHASE units on the wire and on the screen; the recipe figure is
                      the small declared hint underneath. */}
                  <div className="text-right font-mono whitespace-nowrap">
                    <div>{s.display.remaining.primary}</div>
                    {s.display.remaining.hint && (
                      <div className="text-[9px] text-[#B8A590]">{s.display.remaining.hint}</div>
                    )}
                    <div className="text-[9px] text-[#8B7355]">of {s.display.accepted.primary} received</div>
                  </div>
                  {/* rate-basis: purchase — unit_price is ₹ per PURCHASE unit, as billed
                      on this GRN line. Displayed, never multiplied here. */}
                  <div className="text-right font-mono whitespace-nowrap">
                    {money(s.unit_price)}<span className="text-[10px] text-[#8B7355]">/{s.purchase_unit}</span>
                  </div>
                  <div className="text-right">
                    {!s.window_open ? (
                      <span className="text-[10px] text-amber-700" title={s.window_note}>Return window closed</span>
                    ) : already ? (
                      <span className="text-[10px] text-emerald-700">Added</span>
                    ) : (
                      <button onClick={() => addLine(s)}
                              className="px-2 py-1 text-[11px] rounded border border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100">
                        <Plus className="w-3 h-3 inline" /> Add
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {truncated && (
          <div className="px-3 py-2 text-[10px] text-[#8B7355] border-t border-[#E8D5C4]">
            Showing the first page of matches — narrow the search to see the rest.
          </div>
        )}
      </div>

      {/* Lines */}
      {lines.length === 0 ? (
        <div className="text-xs text-[#8B7355] bg-white border border-dashed border-[#E8D5C4] rounded-lg p-4 text-center">
          Add at least one GRN line above. A vendor return cannot be raised against a material on its own —
          the same item often arrives on several GRNs at different rates, with and without a PO.
        </div>
      ) : (
        <div className="space-y-2">
          {lines.map(l => (
            <LineEditor key={l.key} line={l} allowDisposition={false}
                        showReasonError={touched}
                        onChange={p => patch(l.key, p)} onRemove={() => remove(l.key)} />
          ))}
        </div>
      )}

      {/* Header fields */}
      <div className="bg-white border border-[#E8D5C4] rounded-lg p-3 grid grid-cols-1 sm:grid-cols-12 gap-2 text-xs">
        <label className="flex flex-col gap-1 text-[#6B5744] sm:col-span-3">
          <span>Return date</span>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
                 className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
        </label>
        <label className="flex flex-col gap-1 text-[#6B5744] sm:col-span-3">
          <span>Credit note no. <span className="text-[10px] text-[#8B7355]">(recorded only)</span></span>
          <input value={creditNo} onChange={e => setCreditNo(e.target.value)}
                 className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
        </label>
        <label className="flex flex-col gap-1 text-[#6B5744] sm:col-span-3">
          <span>Credit note date</span>
          <input type="date" value={creditDate} onChange={e => setCreditDate(e.target.value)}
                 className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
        </label>
        <label className="flex flex-col gap-1 text-[#6B5744] sm:col-span-3">
          <span>Credit note amount</span>
          <input type="number" step="any" min="0" inputMode="decimal" value={creditAmount}
                 onChange={e => setCreditAmount(e.target.value.replace(/^-+/, ''))}
                 className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] font-mono" />
          {expectedCredit > 0 && (
            <button type="button" onClick={() => setCreditAmount(String(Math.round(expectedCredit * 100) / 100))}
                    className="text-[10px] text-[#af4408] hover:underline text-left">
              Use {money(expectedCredit)} (GRN rate × quantity)
            </button>
          )}
        </label>
        <label className="flex flex-col gap-1 text-[#6B5744] sm:col-span-12">
          <span>Ticket notes</span>
          <input value={notes} onChange={e => setNotes(e.target.value)}
                 placeholder="Anything the HOD and the store should know"
                 className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
        </label>
      </div>

      {saveErr && (
        <div className="flex items-start gap-2 text-xs bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {saveErr}
        </div>
      )}
    </Sheet>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * INTERNAL FLOW — requirement 77. Department → central store, same rail as the
 * issue that put the goods there, reversed.
 * ──────────────────────────────────────────────────────────────────────────── */

function InternalComposer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [depts, setDepts] = useState<DeptRow[]>([]);
  const [deptId, setDeptId] = useState('');
  const [scope, setScope] = useState<{ is_main_department: boolean; sub_departments: Array<{ id: string; name: string }> } | null>(null);
  const [search, setSearch] = useState('');
  const [sources, setSources] = useState<InternalSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [pickerErr, setPickerErr] = useState('');

  const [date, setDate] = useState(todayISO());
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [notes, setNotes] = useState('');

  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const [touched, setTouched] = useState(false);

  // Departments + the signed-in user's own, so the common case is preselected.
  useEffect(() => {
    (async () => {
      const [d, me] = await Promise.all([
        fetch('/api/departments').then(r => r.json()).catch(() => ({ departments: [] })),
        fetch('/api/auth/me').then(r => r.json()).catch(() => ({ user: null })),
      ]);
      const list: DeptRow[] = (d.departments || []).filter((x: DeptRow) => x.is_active);
      const mine = me?.user?.department_id;
      // OFFER ONLY WHAT THE SERVER WILL ACCEPT. POST /api/returns lets a
      // non-admin raise for their OWN department only, so listing every
      // department here just invites a full cart to be built against another
      // kitchen and refused at the final click. An admin still picks freely,
      // which is the exemption the owner kept.
      //
      // A non-admin with no department gets an empty list, which is correct and
      // matches the server: they cannot raise an internal return at all, and the
      // button that opens this composer is already disabled for them.
      const offer = me?.user?.role === 'admin' ? list : list.filter(x => x.id === mine);
      setDepts(offer);
      if (mine && offer.some(x => x.id === mine)) setDeptId(mine);
    })();
  }, []);

  // What this ONE department can actually give back. Deliberately not rolled up
  // into sub-departments: a return posts against one department_id and the
  // Accept caps it against that one pair, so a rolled-up figure would offer a
  // quantity the Accept is guaranteed to refuse.
  useEffect(() => {
    if (!deptId) { setSources([]); setScope(null); return; }
    let dead = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ mode: 'internal', department_id: deptId });
        if (search.trim()) qs.set('search', search.trim());
        const r = await fetch(`/api/returns/sources?${qs}`);
        const j = await r.json();
        if (dead) return;
        if (!r.ok) { setPickerErr(j.error || 'Could not load department stock'); setSources([]); return; }
        setPickerErr('');
        setSources(j.rows || []);
        setScope(j.scope || null);
      } catch (e) {
        if (!dead) setPickerErr(errText(e) || 'Could not load department stock');
      } finally {
        if (!dead) setLoading(false);
      }
    }, 250);
    return () => { dead = true; clearTimeout(t); };
  }, [deptId, search]);

  const addLine = (s: InternalSource) => {
    if (lines.some(l => l.material_id === s.material_id)) return;
    const converts = s.qty.pack_factor > 1;
    setLines(prev => [...prev, {
      key: newKey(),
      material_id: s.material_id,
      material_name: s.material_name,
      recipe_unit: s.unit,
      unit: s.purchase_unit || s.unit,
      pack_factor: s.pack_factor,
      qty: '',
      reason: '',
      disposition: 'reusable',
      notes: '',
      // The server hands back the returnable figure ALREADY converted into the
      // purchase basis inside its DualQty. Taking qty_purchase (and only when
      // the material really converts) is what keeps the ceiling in the same
      // basis as the box the user types in.
      max_purchase: converts ? s.qty.qty_purchase : s.qty.qty,
      max_label: `${s.display.primary} returnable`,
      never_counted: s.never_counted,
    }]);
  };

  const patch = (key: string, p: Partial<DraftLine>) =>
    setLines(prev => prev.map(l => (l.key === key ? { ...l, ...p } : l)));
  const remove = (key: string) => setLines(prev => prev.filter(l => l.key !== key));

  const blankReason = lines.some(l => !l.reason.trim());
  const blankQty    = lines.some(l => !(parseFloat(l.qty) > 0));
  const canSave     = !!deptId && lines.length > 0 && !blankReason && !blankQty;
  const writeOffs   = lines.filter(l => l.disposition !== 'reusable').length;

  const save = async (thenSubmit: boolean) => {
    setTouched(true);
    if (!canSave) return;
    setSaving(true); setSaveErr('');
    try {
      const res = await api('/api/returns', {
        method: 'POST',
        body: {
          kind: 'internal',
          date,
          department_id: deptId,
          notes,
          items: lines.map(l => ({
            material_id: l.material_id,
            quantity: parseFloat(l.qty) || 0,
            unit: l.unit,               // PURCHASE unit — the basis the box was typed in
            reason: l.reason.trim(),
            disposition: l.disposition,
            notes: l.notes,
          })),
        },
      });
      const j = await res.json();
      if (!res.ok) { setSaveErr(j.error || 'Could not save the return'); return; }
      if (thenSubmit && j?.return?.id) {
        const sr = await api(`/api/returns/${j.return.id}/submit`, { method: 'POST', body: {} });
        if (!sr.ok) {
          const sj = await sr.json().catch(() => ({}));
          setSaveErr(`Saved as draft ${j.return.ret_number}, but could not submit: ${sj.error || 'unknown error'}`);
          return;
        }
      }
      onSaved();
    } catch (e) {
      setSaveErr(errText(e) || 'Could not save the return');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      title="Return to Store"
      subtitle="A department gives issued items back to the central store. The goods never leave the building."
      tone="bg-indigo-50"
      onClose={onClose}
      footer={
        <>
          <div className="text-[11px] text-[#6B5744] w-full sm:w-auto sm:mr-auto">
            {lines.length} line(s)
            {writeOffs > 0 && <span className="text-amber-700"> · {writeOffs} written off (not restocked)</span>}
            {blankReason && <span className="text-red-600"> · a reason is required on every line</span>}
            {!blankReason && blankQty && <span className="text-red-600"> · every line needs a quantity</span>}
          </div>
          <button onClick={onClose} className="px-3 py-2 text-sm border border-[#E8D5C4] rounded-lg bg-white text-[#6B5744]">
            Cancel
          </button>
          <button onClick={() => save(false)} disabled={saving || !canSave}
                  className="px-3 py-2 text-sm border border-[#E8D5C4] rounded-lg bg-white text-[#6B5744] disabled:opacity-50">
            <span className="hidden sm:inline">Save draft</span><span className="sm:hidden">Draft</span>
          </button>
          <button onClick={() => save(true)} disabled={saving || !canSave}
                  className="px-3 py-2 text-sm rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white flex items-center gap-1.5 disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Undo2 className="w-4 h-4" />}
            <span className="hidden sm:inline">Save &amp; send for approval</span><span className="sm:hidden">Send</span>
          </button>
        </>
      }
    >
      <StockMovesNotice kind="internal" />

      {/* Department + search */}
      <div className="bg-white border border-[#E8D5C4] rounded-lg p-3 grid grid-cols-1 sm:grid-cols-12 gap-2 text-xs">
        <label className="flex flex-col gap-1 text-[#6B5744] sm:col-span-5">
          <span><Building2 className="w-3 h-3 inline" /> Department returning the goods</span>
          <select value={deptId}
                  onChange={e => { setDeptId(e.target.value); setLines([]); }}
                  className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]">
            <option value="">Choose a department…</option>
            {depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[#6B5744] sm:col-span-4">
          <span>Return date</span>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
                 className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
        </label>
        <div className="flex flex-col gap-1 text-[#6B5744] sm:col-span-3">
          <span>Find an item</span>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2 top-2 text-[#8B7355]" />
            <input value={search} onChange={e => setSearch(e.target.value)} disabled={!deptId}
                   placeholder="Item name…"
                   className="w-full pl-8 pr-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] disabled:opacity-50" />
          </div>
        </div>
      </div>

      {/* A main department holds nothing itself — say so instead of showing an empty list. */}
      {scope?.is_main_department && scope.sub_departments.length > 0 && (
        <div className="text-[11px] bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2">
          This is a main department and the list below is <b>not</b> rolled up — stock sits in its
          sub-departments ({scope.sub_departments.map(s => s.name).join(', ')}). Pick the one that
          actually holds the goods, or the store will not be able to accept the return.
        </div>
      )}

      {pickerErr && (
        <div className="flex items-start gap-2 text-xs bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {pickerErr}
        </div>
      )}

      {/* What the department holds */}
      {deptId && !pickerErr && (
        <div className="bg-white border border-[#E8D5C4] rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-[#E8D5C4] flex items-center gap-2 text-[11px] text-[#6B5744]">
            <span>What this department can give back</span>
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin ml-auto" />}
          </div>
          {/* Same reasoning as the vendor picker: a reflowing grid rather than a
              min-width table, so the Add button is reachable at 375px without a
              sideways scroll. */}
          <div className="max-h-[300px] overflow-y-auto text-xs">
            <div className="hidden sm:grid grid-cols-[1.4fr_auto_auto_auto] gap-x-3 px-3 py-1.5 bg-[#FFF1E3] text-[#6B5744]">
              <span>Item</span>
              <span className="text-right">On hand</span>
              <span className="text-right">Returnable</span>
              <span className="w-16"></span>
            </div>
            {sources.length === 0 && !loading && (
              <div className="p-6 text-center text-[#8B7355]">Nothing recorded against this department yet.</div>
            )}
            {sources.map(s => {
              const already = lines.some(l => l.material_id === s.material_id);
              const meta: PackMeta = {
                unit: s.unit, purchase_unit: s.purchase_unit, pack_size: s.pack_size,
              };
              return (
                <div key={s.material_id}
                     className="border-t border-[#E8D5C4]/50 px-3 py-2 grid grid-cols-2 sm:grid-cols-[1.4fr_auto_auto_auto] gap-x-3 gap-y-1 items-center hover:bg-[#FFF8F0]">
                  <div className="col-span-2 sm:col-span-1 min-w-0">
                    <div className="font-medium text-[#2D1B0E]">{s.material_name}</div>
                    {s.category && <div className="text-[10px] text-[#8B7355]">{s.category}</div>}
                  </div>
                  {/* NEVER COUNTED IS NOT ZERO. A pair with no closing count and no
                      opening row has no on-hand figure at all, and printing a
                      plausible 0 beside a non-zero Returnable is how a storekeeper
                      concludes the ledger is broken. Say what is true. */}
                  <div className="text-right font-mono whitespace-nowrap">
                    <span className="sm:hidden text-[10px] font-sans text-[#8B7355] mr-1">On hand</span>
                    {s.never_counted || s.on_hand === null ? (
                      <span className="text-[10px] font-sans px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                        never counted
                      </span>
                    ) : (
                      <Qty d={dualQty(s.on_hand, meta)} />
                    )}
                  </div>
                  <div className="text-right font-mono whitespace-nowrap">
                    <span className="sm:hidden text-[10px] font-sans text-[#8B7355] mr-1">Returnable</span>
                    <Qty d={s.qty} strong />
                    {/* whitespace-normal: at 375px this sentence is wider than the
                        column and nowrap clipped it mid-word. */}
                    {!s.returnable_exact && (
                      <div className="text-[9px] text-[#B8A590] whitespace-normal">re-checked when the store accepts</div>
                    )}
                  </div>
                  <div className="col-span-2 sm:col-span-1 text-right">
                    {already ? (
                      <span className="text-[10px] text-emerald-700">Added</span>
                    ) : (
                      <button onClick={() => addLine(s)} disabled={!s.can_return}
                              className="px-2 py-1 text-[11px] rounded border border-indigo-200 bg-indigo-50 text-indigo-800 hover:bg-indigo-100 disabled:opacity-40">
                        <Plus className="w-3 h-3 inline" /> Add
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Lines */}
      {lines.length === 0 ? (
        <div className="text-xs text-[#8B7355] bg-white border border-dashed border-[#E8D5C4] rounded-lg p-4 text-center">
          {deptId ? 'Add at least one item from the list above.' : 'Choose a department to see what it can give back.'}
        </div>
      ) : (
        <div className="space-y-2">
          {lines.map(l => (
            <div key={l.key}>
              <LineEditor line={l} allowDisposition
                          showReasonError={touched}
                          onChange={p => patch(l.key, p)} onRemove={() => remove(l.key)} />
              {l.never_counted && (
                <div className="text-[10px] text-amber-700 px-3 pt-1">
                  This department has never counted this item, so the returnable figure is the running
                  movement total, not a counted balance. The store re-checks it at Accept.
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <label className="flex flex-col gap-1 text-xs text-[#6B5744]">
        <span>Ticket notes</span>
        <input value={notes} onChange={e => setNotes(e.target.value)}
               placeholder="Anything the HOD and the store should know"
               className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-white" />
      </label>

      {saveErr && (
        <div className="flex items-start gap-2 text-xs bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {saveErr}
        </div>
      )}
    </Sheet>
  );
}
