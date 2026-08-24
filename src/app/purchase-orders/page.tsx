'use client';

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ClipboardList, Plus, Trash2, Search, Loader2, CheckCircle2, XCircle, Send,
  ShieldCheck, PackageCheck, RefreshCw, AlertTriangle, ChevronDown, Printer, Lock,
} from 'lucide-react';
import { api } from '@/lib/api';
import { allocateBillCharges, resolveCharge, r2, MIN_NET_RATE, NON_ADMIN_DISCOUNT_CAP_PCT } from '@/lib/po-charges';
import { packFactor, toPurchaseQty, fmtQtyNum, type PackMeta } from '@/lib/pack-units';
import StockOnHandNote, { StockOnHandLegend } from '@/components/StockOnHandNote';
import { useStockOnHand, type StockOnHandState } from '@/lib/use-stock-on-hand';

// Always 2 dp: at 0 dp the paise were dropped per row, so the item column
// visibly failed to add up to the footer/list total (₹235.50 + ₹118.50 showed
// as ₹236 + ₹119 = ₹355 against a ₹354 header). Every ₹ TOTAL on this page goes
// through this one formatter; the per-line rates spell out .toFixed(2) inline.
// Either way nothing on this page rounds money to whole rupees, so the same
// number never reads two different ways in two places.
const fmt = (v: number) => '₹' + (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateLabel = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
/** Today on the LOCAL calendar, as YYYY-MM-DD. `toISOString().slice(0,10)`
 *  answers in UTC, which is 5½ h behind IST — before 05:30 it names YESTERDAY,
 *  so a delivery that fell due yesterday would not read as overdue until half
 *  past five in the morning. Only the expected-delivery test uses this; the
 *  date-input defaults elsewhere on this page are unchanged. */
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
/** Statuses that mean "nothing more is coming": a PO closed out or fully in can
 *  never be late. Everything else — including 'approved', which is where a
 *  PART-received PO sits — is still owed goods, so a passed delivery date is a
 *  real overdue. */
const SETTLED_STATUSES = ['received', 'cancelled', 'rejected'];
/** Is this PO past its expected delivery date and still owed goods? Purely
 *  client-side off the row we already hold — no extra fetch. NULL delivery_date
 *  is never overdue: we do not know when it was due, and inventing a date here
 *  would put a red flag on every PO raised before the column existed. */
const isDeliveryOverdue = (deliveryDate?: string | null, status?: string): boolean => {
  const due = String(deliveryDate || '').slice(0, 10);
  if (!due) return false;
  if (SETTLED_STATUSES.includes(String(status || ''))) return false;
  return due < todayIso();
};
/** Vendor line-tally on a list row: [{ vendor_name, line_count }, …].
 *
 *  ONE reader, because the field is absent on the detail branch and on any
 *  payload a tab cached from before the aggregate shipped — anything but an
 *  array must read as "the server did not say", not as an empty vendor.
 *
 *  Note what this deliberately does NOT do: split a comma-joined string. The
 *  route ships objects precisely because a vendor name legitimately contains a
 *  comma ("Solo Traders, Hyd"), and splitting one would invent a second vendor
 *  who is owed goods. Display joins below use ' · ' for the same reason. */
type VendorTally = { vendor_name: string; line_count: number };
const vendorTally = (v: unknown): VendorTally[] =>
  Array.isArray(v)
    ? v.map((x: any) => ({
        vendor_name: String(x?.vendor_name ?? '').trim() || '(no vendor)',
        line_count: Number(x?.line_count) || 0,
      }))
    : [];
/** QTY for humans. Binary floats make 2.4 − 2.5 = −0.09999999999999964, and that
 *  string was being read out to the receiver in the deviation hint, the blocking
 *  banner, the button tooltip and the submit alert. 6 dp is far finer than any
 *  qty a receiving bay types, so this only ever trims the noise. */
const qfmt = (n: number) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 6 });
/** "Differs from the PO" tolerances — the receive route's own values
 *  (receive/route.ts QTY_EPS / RATE_EPS). Kept identical so this screen never
 *  demands a reason for a difference the server would ignore, or vice versa. */
const QTY_EPS = 1e-6;
const RATE_EPS = 0.005;   // ₹ — half a paisa

/**
 * The GST rates a vendor bill in this kitchen actually carries. A fixed list and
 * not a free number box, for the same reason as the vendor-bill form on /grn: a typo'd "1.8" on a ₹40,000 bill is a tax figure nobody catches
 * until the return is filed. Same five values, same order — the two screens that
 * take a vendor bill must not offer different tax rates.
 *
 * 28 is here because the master's Tax % now SEEDS this select (see `load`).
 * A material set to 28% (aerated drinks, the classic case) whose rate is not an
 * <option> renders the select BLANK — the receiver reads 0%, the compute books
 * 28%. Do not trim this list without also trimming what the master accepts.
 */
const GST_RATES = ['0', '5', '12', '18', '28'] as const;

interface Material { id: string; name: string; unit: string; purchase_unit?: string; pack_size?: number; sku?: string; average_price: number; primary_vendor?: string; last_purchase_price?: number; }

/* ── PO UNIT BASIS ────────────────────────────────────────────────────────────
 * A Purchase Order is raised to a VENDOR, so it must be expressed in the
 * material's PURCHASE unit (kg, L, BTL, CASE…) at ₹ per PURCHASE unit — never
 * the recipe/stock unit (g, ml) the kitchen consumes in.
 *   raw_materials.unit           = RECIPE unit  (e.g. g)
 *   raw_materials.purchase_unit  = PURCHASE unit (e.g. kg)
 *   raw_materials.average_price  = ₹ per RECIPE unit  (e.g. ₹0.90/g)
 *   purchases.unit_price / last_purchase_price = ₹ per PURCHASE unit (₹900/kg)
 * So average_price must be multiplied by pack_size to become a PO rate.
 * (See lib/pack-units + the unit convention: stock is recipe units = purchase
 * qty × pack_size, hence ₹/purchase-unit = ₹/recipe-unit × pack_size.) */
const poUnitOf = (m?: Partial<Material> | null): string =>
  String(m?.purchase_unit || '').trim() || String(m?.unit || '').trim();
/** Seed rate for a PO line: ₹ per PURCHASE unit. Prefers the last actual
 *  purchase price (already ₹/purchase-unit); otherwise converts the recipe-unit
 *  average by pack size. Returns 0 when we genuinely have no price. */
const poRateOf = (m?: Partial<Material> | null): number => {
  // NAME TRAP — read this before touching the line below.
  // `Material` is filled from GET /api/inventory?scope=all (see fetchAll), and
  // that route does NOT ship the stored raw_materials column of this name. It
  // ships a SQL ALIAS over the newest purchases row:
  //     COALESCE((SELECT unit_price FROM purchases
  //               WHERE material_id = rm.id
  //               ORDER BY date DESC, created_at DESC LIMIT 1), 0)
  //               AS last_purchase_price          (api/inventory/route.ts:40)
  // The alias is listed AFTER `rm.*`, so it overwrites the stored column in the
  // row object — verified on live data: CURD comes back 80 (the real Rs/kg off
  // purchases) while the stored column holds 86, a Rs/kg figure parked in a
  // Rs/g column. purchases.unit_price is Rs per PURCHASE unit by canon, which is
  // exactly the basis a PO line is raised in, so this seed needs no conversion.
  // Anything reaching this helper from a payload that did NOT alias the column
  // would be mixed-basis and must not be used — go through /api/inventory.
  // rate-basis: purchase (alias over purchases.unit_price, NOT the stored column)
  const last = Number(m?.last_purchase_price) || 0;
  if (last > 0) return last;
  const pack = Number(m?.pack_size) || 1;
  const ru = String(m?.unit || '').toLowerCase().trim();
  const pu = String(m?.purchase_unit || m?.unit || '').toLowerCase().trim();
  const avg = Number(m?.average_price) || 0;
  return (pack > 1 && ru !== pu) ? Math.round(avg * pack * 100) / 100 : avg;
};

/* ── PURCHASE-LEAD DISPLAY (owner rule) ───────────────────────────────────────
 * Every quantity on this page LEADS in the purchase unit; the recipe figure
 * rides along as a small hint whenever the pack factor is real. A PO quantity is
 * ALREADY stored in purchase units, so nothing here ever DIVIDES an ordered /
 * received qty — the hint MULTIPLIES up to the recipe basis. Only the approval
 * drawer's stock + usage columns (recipe-basis columns off raw_materials) get
 * divided, and they go through toPurchaseQty.
 *
 * The both-halves guard (pack > 1 AND recipe unit ≠ purchase unit) lives in
 * packFactor() and is never re-derived here — two copies is how the bases drift.
 */
const HINT_CLS = 'text-[9px] text-[#B8A590]';
/** Pack meta off any API row that carries the material_* trio (PO items,
 *  approval-context items). purchase_unit falls back to the recipe unit exactly
 *  as the SQL COALESCE does, so packFactor's guard sees the same pair server and
 *  client. */
const packMetaOf = (r: any): PackMeta => ({
  unit: r?.material_unit,
  purchase_unit: r?.material_purchase_unit || r?.material_unit,
  pack_size: r?.material_pack_size,
});
/** Pack meta from an inventory Material (the composer's picker list). */
const packMetaOfMat = (m?: Partial<Material> | null): PackMeta => ({
  unit: m?.unit, purchase_unit: m?.purchase_unit || m?.unit, pack_size: m?.pack_size,
});
/** "= 10,000 g" — the recipe-unit equivalent of a PURCHASE quantity. Null when
 *  there is no real pack conversion: the two bases are then the same number and
 *  a hint would only add noise. DISPLAY ONLY — never post this back. */
const recipeHint = (purchaseQty: number, m: PackMeta): string | null => {
  const pf = packFactor(m);
  if (pf <= 1) return null;
  return `= ${fmtQtyNum((Number(purchaseQty) || 0) * pf)} ${String(m.unit || '').trim()}`.trim();
};
/** "1 kg = 1,000 g" — states the pack itself, for the composer's item note. */
const packNote = (m: PackMeta): string | null => {
  const pf = packFactor(m);
  if (pf <= 1) return null;
  return `1 ${String(m.purchase_unit || '').trim()} = ${fmtQtyNum(pf)} ${String(m.unit || '').trim()}`;
};

interface POItem {
  id: string; material_id: string; material_name?: string; material_sku?: string;
  /** RECIPE unit (g/ml) — for the hint only; a PO line is never expressed in it. */
  material_unit?: string;
  /** PURCHASE unit (kg/BTL/CASE) — the basis of quantity AND unit_price. */
  material_purchase_unit?: string;
  /** raw_materials.pack_size — recipe units per purchase unit. */
  material_pack_size?: number;
  quantity: number; unit_price: number; total_price: number;
  /** raw_materials.tax_percent — the master's GST rate, carried by the PO detail
   *  API purely to SEED this line's GST% on Receive. It is a default, not a
   *  verdict: the printed vendor bill wins, so the receiver can change it. */
  material_tax_percent?: number;
  /** raw_materials.cess_percent — the master's GST COMPENSATION CESS rate, and
   *  it IS consumed on this screen now: it seeds the line's Cess % on Receive
   *  exactly the way material_tax_percent seeds the GST%. Same standing as that
   *  seed — a default, not a verdict; the printed vendor bill wins.
   *  The rupees land on goods_receipt_note_items.compensation_cess, the eighth
   *  charge column of the GRN item (the bill document this path books tax onto),
   *  NOT on purchases.compensation_cess — the purchases row written here is the
   *  deliberately tax-free COST mirror of the GRN line, and putting the same
   *  rupee on both is what purchase-log's is_mirror split exists to prevent.
   *  It is also NOT special_excise_cess, which still means TGBCL Special Excise
   *  Cess everywhere it is read — writing GST compensation cess into that column
   *  would report an excise figure nobody levied.
   *  And it is NOT part of the cgst + sgst invariant: cess is a separate levy,
   *  never halved. It is charged on the GROSS line value, BEFORE the bill
   *  discount, while GST is charged AFTER it — see billCalc. */
  material_cess_percent?: number;
  /** raw_materials.average_price — Rs per RECIPE unit. Scale by pack_size before
   *  putting it next to a PO rate. No last-purchase-rate field rides here: the
   *  detail API stopped sending that mixed-basis column, and the composer's seed
   *  rate comes from the Material list (/api/inventory), not from a PO item. */
  current_avg_price?: number; notes?: string;
  /** LINE vendor — one PO legitimately spans several. Receiving is per vendor. */
  vendor?: string; vendor_id?: string | null;
}

/**
 * One vendor's stake in a PO, from GET /api/purchase-orders/:id/receive.
 * `line_ids` are the lines this vendor still owes; `done` means there is
 * nothing left for them to deliver (all in, or all store-mapped).
 */
interface VendorStake {
  key: string; vendor_name: string; vendor_id: string | null;
  line_ids: string[]; received_line_ids: string[]; blocked_line_ids: string[];
  ordered_value: number; done: boolean; grn_numbers: string[];
  bills: { id: string; bill_no: string; bill_date: string; received_by: string; created_at: string }[];
}
interface PO {
  id: string; po_number: string; date: string; vendor: string; status: string; total_cost: number;
  notes: string; drafted_by: string; submitted_at?: string; approved_by?: string; approved_at?: string;
  rejected_reason?: string; received_at?: string; item_count?: number; items?: POItem[];
  /** purchase_orders.delivery_date — the date the vendor PROMISED, labelled
   *  "Expected Delivery Date" everywhere a human sees it. Nullable and never
   *  backfilled: a PO raised before the column existed has no promise on record,
   *  and no surface may invent one. */
  delivery_date?: string;
  /* ── PER-PO RECEIPT AGGREGATE (list branch only) ─────────────────────────
   * Optional on purpose. The detail branch does not send them, and a tab left
   * open across the deploy holds a cached payload that predates them — so every
   * reader below null-checks rather than assuming a number. LINE counts, never
   * summed quantities: 2 kg + 3 BTL is not a quantity. */
  received_line_count?: number;
  total_line_count?: number;
  /** Who is still owed / who has already delivered, with the LINE count each.
   *  A vendor who part-delivered appears in both. Read through vendorTally(). */
  outstanding_vendors?: VendorTally[];
  delivered_vendors?: VendorTally[];
  /** Vendor bill numbers taken in against this PO (the "Bill Number" half of
   *  vendor-wise receiving). Empty on an un-migrated DB — never assumed. */
  vendor_bills?: Array<{ vendor_name: string; bill_no: string; bill_date: string }>;
}

const STATUS_COLOR: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700',
  pending: 'bg-amber-100 text-amber-800',
  pending_reapproval: 'bg-amber-100 text-amber-800',
  approved: 'bg-blue-100 text-blue-800',
  received: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-700',
  cancelled: 'bg-slate-100 text-slate-500 line-through',
};

/**
 * THE tab → statuses map. The row filter and the tab badge both read this, so a
 * PO counted in a tab is always listed in it.
 *
 * They used to be written separately and had drifted apart in two places:
 *   • the badge counted 'cancelled' under Rejected/Cancelled while the filter
 *     tested `status === 'rejected'`, so a cancelled PO showed as "(1)" over an
 *     empty "No POs in this view";
 *   • 'pending_reapproval' — written by [id]/edit-approved and accepted by
 *     approve/reject — appeared in NO map at all, so a PO sent back for
 *     re-approval was invisible everywhere except the All tab, silently missing
 *     from the approval queue.
 * Add a new status here and both surfaces pick it up together.
 */
const TAB_STATUSES: Record<string, string[]> = {
  draft:    ['draft'],
  pending:  ['pending', 'pending_reapproval'],
  approved: ['approved'],
  received: ['received'],
  rejected: ['rejected', 'cancelled'],
};

export default function PurchaseOrdersPage() {
  const [pos, setPos] = useState<PO[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  // Starts at the LOWER tier, same rule as the setter below: until the server
  // has actually said "admin", the answer to "is this viewer an admin" is no.
  // (It also stops a manager's first paint claiming "signed in as ADMIN".)
  const [role, setRole] = useState<'admin' | 'manager'>('manager');
  const [loading, setLoading] = useState(true);
  /* Landing from a PO link on Purchases (/purchase-orders?q=PO-2026-0001) seeds
   * the search box AND widens the tab to 'all'. Both matter: the default tab is
   * 'pending', so a received PO — which is exactly the kind a purchase row links
   * to — would be filtered out and the link would look broken while working
   * perfectly. Read once at mount from window.location, deliberately not
   * useSearchParams, so this needs no Suspense boundary around the page. */
  const initialQ = typeof window !== 'undefined'
    ? (new URLSearchParams(window.location.search).get('q') || '')
    : '';
  const [tab, setTab] = useState<'all' | 'draft' | 'pending' | 'approved' | 'received' | 'rejected'>(
    initialQ ? 'all' : 'pending',
  );
  const [search, setSearch] = useState(initialQ);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [openDetailId, setOpenDetailId] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);   // approval-context drawer
  const [receivingId, setReceivingId] = useState<string | null>(null);
  // Approved-PO line edit (add items / change quantities, same PO). Backend:
  // [id]/edit-approved — replaces the line set and drops the PO to
  // pending_reapproval, forcing a fresh admin approval. Refused once ANY goods
  // are received (lines are frozen after receipt so a delivery cannot be
  // received twice); the button greys out on part-received rows for the same
  // reason the server refuses.
  const [editApprovedPo, setEditApprovedPo] = useState<PO | null>(null);
  const [rejectingPo, setRejectingPo] = useState<PO | null>(null);
  const [approvingPo, setApprovingPo] = useState<PO | null>(null);
  const [poFlagCount, setPoFlagCount] = useState<Record<string, number>>({});  // poId → flag total


  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [posRes, invRes] = await Promise.all([
        fetch('/api/purchase-orders').then(r => r.json()),
        // scope=all — POs are a store operation; show every material.
        fetch('/api/inventory?scope=all').then(r => r.json()),
      ]);
      setPos(posRes.purchase_orders || []);
      // Fail CLOSED to the lower tier. This was `=== 'manager' ? 'manager' : 'admin'`,
      // which handed out 'admin' for anything that wasn't literally "manager" — an
      // absent field, an error body, a future role string. `role` gates the
      // admin-only rate unlock in the receive modal, so an unexpected value must
      // never resolve to the MORE privileged answer. Only an explicit 'admin' is admin.
      setRole(posRes.viewer_role === 'admin' ? 'admin' : 'manager');
      setMaterials(invRes.materials || []);
    } catch {
      // Promise.all rejecting (network blip, a non-JSON 500 so r.json() throws)
      // used to skip BOTH setters and leave `role` at whatever it was — which,
      // on the first load, was 'admin'. Fail closed explicitly: no rows, lower
      // tier. Refresh re-runs this.
      setPos([]);
      setRole('manager');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Role is now driven by the logged-in user (api/auth/me). Toggle is removed.

  const filtered = useMemo(() => {
    let list = pos;
    // Same map the badges use — never `status === tab`, which silently drops any
    // status whose name isn't identical to the tab key (cancelled, pending_reapproval).
    if (tab !== 'all') {
      const allowed = TAB_STATUSES[tab] || [tab];
      list = list.filter(p => allowed.includes(p.status));
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(p => p.po_number.toLowerCase().includes(q) || (p.vendor || '').toLowerCase().includes(q));
    }
    return list;
  }, [pos, tab, search]);

  // Derived from TAB_STATUSES so a badge can never count something the tab
  // won't show (or miss something it will).
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [key, statuses] of Object.entries(TAB_STATUSES)) {
      out[key] = pos.filter(p => statuses.includes(p.status)).length;
    }
    return out as { draft: number; pending: number; approved: number; received: number; rejected: number };
  }, [pos]);

  const action = async (id: string, kind: 'submit' | 'approve' | 'reject' | 'cancel' | 'receive', body: any = {}) => {
    setSavingId(id);
    try {
      const r = await api(`/api/purchase-orders/${id}/${kind}`, { method: 'POST', body });
      const j = await r.json().catch(() => ({} as any));
      if (!r.ok) { alert(j.error || `Failed to ${kind}`); return; }
      // With `po_require_admin_approval` OFF, submit ALSO approves in the same
      // txn (submit/route.ts returns auto_approved). The default tab is Pending
      // Approval, so without this the PO just vanishes from the list and the
      // user is never told it is now receivable. Say it, then show it.
      if (kind === 'submit' && j.auto_approved) {
        alert('Submitted and auto-approved — admin approval is currently OFF (Settings → Purchasing).\n\nThis PO is in Approved and can be received now.');
        setTab('approved');
      }
      await fetchAll();
    } finally { setSavingId(null); }
  };

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
              <ClipboardList className="w-6 h-6" /> Purchase Orders
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              Manager drafts &amp; submits — Admin approves — Receiving updates stock and re-prices recipes.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-[#8B7355]">
              You are signed in as <span className={`font-semibold ${role === 'admin' ? 'text-[#af4408]' : 'text-[#6B5744]'}`}>{role.toUpperCase()}</span>
              {role !== 'admin' && <span className="ml-1">— Approve / Reject is admin-only</span>}
            </span>
            <button onClick={() => setCreating(true)}
                    className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium">
              <Plus className="w-4 h-4" /> New PO
            </button>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 shadow flex flex-wrap items-center gap-3">
          {/* Segmented control scrolls sideways on phones instead of overflowing;
              scrollbar hidden. max-w-full keeps it inside the wrapping toolbar. */}
          <div className="flex gap-1 bg-[#FFF1E3] rounded-lg p-1 text-xs flex-nowrap overflow-x-auto max-w-full no-scrollbar">
            {([
              ['all',      `All (${pos.length})`,                       'bg-[#af4408]'],
              ['draft',    `Draft (${counts.draft})`,                   'bg-gray-600'],
              ['pending',  `Pending Approval (${counts.pending})`,      'bg-amber-500'],
              ['approved', `Approved (${counts.approved})`,             'bg-blue-600'],
              ['received', `Received (${counts.received})`,             'bg-green-600'],
              ['rejected', `Rejected/Cancelled (${counts.rejected})`,   'bg-red-600'],
            ] as const).map(([v, label, bg]) => (
              <button key={v} onClick={() => setTab(v as any)}
                      className={`px-2.5 py-1 rounded-md font-medium transition-colors shrink-0 whitespace-nowrap ${tab === v ? `${bg} text-white` : 'text-[#6B5744] hover:bg-white'}`}>
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-[#8B7355]" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="PO number or vendor…"
                   className="flex-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
          </div>
          <button onClick={fetchAll} className="text-xs text-[#6B5744] hover:text-[#af4408] flex items-center gap-1">
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>

        {/* List */}
        {loading ? (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-[#8B7355] text-sm">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-[#8B7355] text-sm">
            {tab === 'pending' && counts.pending === 0
              ? '✓ Nothing waiting for approval.'
              : 'No POs in this view.'}
          </div>
        ) : (
          <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                  <tr>
                    <th className="text-left  py-2.5 px-3 font-medium">PO #</th>
                    {/* Two dates now sit on this row, so neither may be called
                        just "Date": the one the PO was raised on, and the one
                        the vendor promised. */}
                    <th className="text-left  py-2.5 px-3 font-medium">PO Date</th>
                    <th className="text-left  py-2.5 px-3 font-medium">Expected Delivery</th>
                    <th className="text-left  py-2.5 px-3 font-medium">Vendor</th>
                    <th className="text-right py-2.5 px-3 font-medium">Items</th>
                    <th className="text-right py-2.5 px-3 font-medium">Total</th>
                    <th className="text-left  py-2.5 px-3 font-medium">Status</th>
                    <th className="text-right py-2.5 px-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(p => {
                    const isSaving = savingId === p.id;
                    const isOpen = openDetailId === p.id;
                    const canEdit = p.status === 'draft';
                    const canSubmit = p.status === 'draft';
                    // Derive from the SAME map the tab uses. Testing the literal
                    // 'pending' left a pending_reapproval PO counted in the Pending
                    // Approval tab with no Approve/Reject button — visible but
                    // un-actionable, a worse dead end than being hidden. Both
                    // approve/route.ts:18 and reject/route.ts:22 already accept it.
                    const inApproval = TAB_STATUSES.pending.includes(p.status);
                    const canApprove = inApproval && role === 'admin';
                    const canReject = inApproval && role === 'admin';
                    // Deliberately NOT inApproval: cancel/route.ts:22 accepts only
                    // draft/pending/rejected, so offering it on pending_reapproval
                    // would render a button that 400s. Widen BOTH or neither.
                    const canCancel = ['draft', 'pending', 'rejected'].includes(p.status);
                    const canReceive = p.status === 'approved';
                    const canDelete = p.status === 'draft';
                    // Late on the vendor's own promise, and still owed goods.
                    const overdue = isDeliveryOverdue(p.delivery_date, p.status);
                    /* PART-RECEIVED. Per-vendor receiving leaves a PO at
                       'approved' until the LAST vendor is in, so "APPROVED"
                       alone reads as "nothing has arrived" on a PO that is
                       already half booked into stock, priced and paid for.
                       Every field here is optional — the detail branch never
                       sends them and a tab open across the deploy holds a
                       payload from before they existed — so `Number(x) || 0`
                       collapses "the server did not say" to 0, which shows no
                       chip. Silence is the safe answer; a wrong count is not.
                       item_count backs total_line_count for the same reason:
                       it is the same COUNT of purchase_order_items rows. */
                    const linesIn    = Number(p.received_line_count) || 0;
                    const linesTotal = Number(p.total_line_count) || Number(p.item_count) || 0;
                    const owedVendors = vendorTally(p.outstanding_vendors);
                    const inVendors   = vendorTally(p.delivered_vendors);
                    const partReceived = p.status === 'approved' && linesIn > 0;
                    /* The full picture on hover: who came, under which bill, and
                       who is still out. The chip itself stays short — a row in a
                       list cannot carry three vendors and two bill numbers. */
                    const partTitle = !partReceived ? undefined : [
                      inVendors.length > 0 && `Delivered: ${inVendors.map(v => `${v.vendor_name} (${v.line_count} line${v.line_count === 1 ? '' : 's'})`).join(' · ')}`,
                      (p.vendor_bills || []).length > 0 && `Bills: ${(p.vendor_bills || []).map(b => `${b.vendor_name || '?'} ${b.bill_no || '(no number)'}`).join(' · ')}`,
                      owedVendors.length > 0 && `Still to deliver: ${owedVendors.map(v => `${v.vendor_name} (${v.line_count} line${v.line_count === 1 ? '' : 's'})`).join(' · ')}`,
                    ].filter(Boolean).join('\n') || undefined;
                    return (
                      // Key belongs on the FRAGMENT, not the inner <tr>: a row can
                      // render up to three siblings (row + detail + review), so a
                      // keyless <> makes React reconcile this list by index and
                      // remount everything below an approve/reject reorder.
                      <Fragment key={p.id}>
                        <tr className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30">
                          <td className="py-2 px-3 text-xs font-mono">
                            <button onClick={() => setOpenDetailId(isOpen ? null : p.id)}
                                    className="inline-flex items-center gap-1 hover:text-[#af4408]">
                              <ChevronDown className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                              {p.po_number}
                            </button>
                          </td>
                          <td className="py-2 px-3 text-xs">{dateLabel(p.date)}</td>
                          {/* Expected delivery. NULL prints an em-dash — a PO
                              raised before the column existed carries no promise
                              and must not be given one here. */}
                          <td className="py-2 px-3 text-xs">
                            {p.delivery_date ? (
                              <span className={overdue ? 'text-red-700 font-semibold' : ''}>
                                {dateLabel(p.delivery_date)}
                                {overdue && <span className="ml-1 text-[10px] uppercase tracking-wide">overdue</span>}
                              </span>
                            ) : <span className="text-[#8B7355]">—</span>}
                          </td>
                          <td className="py-2 px-3 text-xs">{p.vendor || <span className="text-[#8B7355]">—</span>}</td>
                          <td className="py-2 px-3 text-xs text-right font-mono">{p.item_count ?? '-'}</td>
                          <td className="py-2 px-3 text-xs text-right font-mono font-semibold">{fmt(p.total_cost)}</td>
                          <td className="py-2 px-3 text-xs">
                            <div className="flex flex-wrap items-center gap-1">
                              <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${STATUS_COLOR[p.status] || 'bg-gray-100'}`}>
                                {p.status.toUpperCase()}
                              </span>
                              {/* Beside the badge, never instead of it: the PO
                                  really is still 'approved' — this says how much
                                  of it has already walked in the door, and who
                                  is still owed. Lines, not quantities. */}
                              {partReceived && (
                                <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-800"
                                      title={partTitle}>
                                  PART-RECEIVED
                                  <span className="font-normal">
                                    {' · '}{linesIn} of {linesTotal || '?'} lines in
                                    {owedVendors.length > 0 && <> · awaiting {owedVendors.map(v => v.vendor_name).join(' · ')}</>}
                                  </span>
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="py-2 px-3 text-xs text-right">
                            <div className="inline-flex items-center gap-1 justify-end">
                              {canEdit && (
                                <button onClick={() => { setEditingId(p.id); setOpenDetailId(p.id); }}
                                        className="px-2 py-1 rounded text-[10px] text-[#6B5744] hover:bg-[#FFF1E3]">Edit</button>
                              )}
                              <a href={`/purchase-orders/${p.id}/print`} target="_blank"
                                 className="px-2 py-1 rounded text-[10px] text-[#6B5744] hover:bg-[#FFF1E3] inline-flex items-center gap-1">
                                <Printer className="w-3 h-3" /> Print
                              </a>
                              {canSubmit && (
                                <button onClick={() => action(p.id, 'submit')} disabled={isSaving}
                                        className="px-2 py-1 rounded text-[10px] bg-amber-500 hover:bg-amber-600 text-white inline-flex items-center gap-1 disabled:opacity-50">
                                  <Send className="w-3 h-3" /> Submit
                                </button>
                              )}
                              {inApproval && (
                                <button onClick={() => setReviewId(reviewId === p.id ? null : p.id)}
                                        className="px-2 py-1 rounded text-[10px] bg-amber-100 hover:bg-amber-200 text-amber-800 inline-flex items-center gap-1">
                                  <AlertTriangle className="w-3 h-3" /> {reviewId === p.id ? 'Hide' : 'Review'}
                                </button>
                              )}
                              {canApprove && (
                                <button onClick={() => setApprovingPo(p)} disabled={isSaving}
                                        className="px-2 py-1 rounded text-[10px] bg-blue-600 hover:bg-blue-700 text-white inline-flex items-center gap-1 disabled:opacity-50">
                                  <ShieldCheck className="w-3 h-3" /> Approve
                                </button>
                              )}
                              {canReject && (
                                <button onClick={() => setRejectingPo(p)} disabled={isSaving}
                                        className="px-2 py-1 rounded text-[10px] bg-red-100 text-red-700 hover:bg-red-200 inline-flex items-center gap-1 disabled:opacity-50">
                                  <XCircle className="w-3 h-3" /> Reject
                                </button>
                              )}
                              {canReceive && (
                                <button onClick={() => setReceivingId(p.id)} disabled={isSaving}
                                        className="px-2 py-1 rounded text-[10px] bg-green-600 hover:bg-green-700 text-white inline-flex items-center gap-1 disabled:opacity-50">
                                  <PackageCheck className="w-3 h-3" /> Receive
                                </button>
                              )}
                              {/* Edit an APPROVED PO's lines (add items / change
                                  quantities — one PO, re-approval forced). Shown
                                  wherever Receive is: same status, and the route
                                  gates admin|manager on the REAL tier itself.
                                  Disabled once anything is received — the server
                                  hard-refuses that with the GRN list, so a live
                                  button would only 409; grey + why is honest. */}
                              {canReceive && (
                                <button onClick={() => setEditApprovedPo(p)}
                                        disabled={isSaving || partReceived}
                                        title={partReceived
                                          ? 'Goods already received against this PO — lines are frozen. Missing goods are left un-received; a wrong rate is corrected on Receive.'
                                          : 'Add items or change quantities — the PO goes back for re-approval'}
                                        className="px-2 py-1 rounded text-[10px] bg-amber-100 text-amber-800 hover:bg-amber-200 inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed">
                                  <ClipboardList className="w-3 h-3" /> Edit items
                                </button>
                              )}
                              {/* Gated on the status itself, NOT the canCancel
                                  array or the tab — the Rejected/Cancelled tab
                                  also holds cancelled POs, which cannot be
                                  revised. Reads before the destructive Cancel. */}
                              {p.status === 'rejected' && (
                                <button onClick={async () => {
                                  setSavingId(p.id);
                                  try {
                                    // DELETE on /reject = withdraw the rejection (back to draft for re-submit).
                                    // Can't use action(): that helper hardcodes method POST.
                                    const r = await api(`/api/purchase-orders/${p.id}/reject`, { method: 'DELETE' });
                                    if (!r.ok) { alert(((await r.json()).error) || 'Failed to revise'); return; }
                                    await fetchAll();
                                  } finally { setSavingId(null); }
                                }} disabled={isSaving}
                                        className="px-2 py-1 rounded text-[10px] bg-amber-500 hover:bg-amber-600 text-white inline-flex items-center gap-1 disabled:opacity-50">
                                  <Send className="w-3 h-3" /> Revise
                                </button>
                              )}
                              {canCancel && p.status !== 'draft' && (
                                <button onClick={() => action(p.id, 'cancel')} disabled={isSaving}
                                        className="px-2 py-1 rounded text-[10px] text-[#8B7355] hover:text-red-700 hover:bg-red-50">
                                  Cancel
                                </button>
                              )}
                              {canDelete && (
                                <button onClick={async () => {
                                  if (!confirm('Delete this draft?')) return;
                                  await api(`/api/purchase-orders?id=${p.id}`, { method: 'DELETE' });
                                  fetchAll();
                                }}
                                        className="p-1 rounded text-red-500 hover:bg-red-50">
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                        {isOpen && (
                          <PODetail key={p.id + '-d'} po={p} editing={editingId === p.id}
                                    onCancelEdit={() => setEditingId(null)}
                                    materials={materials}
                                    onSaved={() => { setEditingId(null); fetchAll(); }} />
                        )}
                        {reviewId === p.id && (
                          <ApprovalContextPanel key={p.id + '-r'} poId={p.id} />
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {creating && (
          <CreatePOModal materials={materials} onClose={() => setCreating(false)} onCreated={fetchAll} />
        )}

        {receivingId && (
          <ReceiveModal poId={receivingId}
                        role={role}
                        onClose={() => setReceivingId(null)}
                        onReceived={() => { setReceivingId(null); fetchAll(); }} />
        )}

        {editApprovedPo && (
          <EditApprovedPOModal po={editApprovedPo}
                               materials={materials}
                               onClose={() => setEditApprovedPo(null)}
                               onSaved={() => { setEditApprovedPo(null); fetchAll(); setTab('pending'); }} />
        )}

        {rejectingPo && (
          <RejectPOModal po={rejectingPo}
                         onClose={() => setRejectingPo(null)}
                         onRejected={async (reason) => {
                           await action(rejectingPo.id, 'reject', { reason });
                           setRejectingPo(null);
                         }} />
        )}

        {approvingPo && (
          <ApprovePOModal po={approvingPo}
                          onClose={() => setApprovingPo(null)}
                          onApproved={async (note) => {
                            await action(approvingPo.id, 'approve', { approval_note: note });
                            setApprovingPo(null);
                          }} />
        )}
      </div>
    </div>
  );
}

/* ============================================================ */
/* Receive Modal — adjust per-line qty/price for partial deliveries */
/* ============================================================ */
/**
 * One bill-level charge row: By % / By Amount + the resolved ₹ figure.
 * Same shape and behaviour as the ad-hoc GRN bill modal on /grn, so the
 * two places a bill is entered look identical; only the effect on cost differs,
 * and `hint` is where that is stated.
 */
function ChargeRow({ label, hint, mode, value, onMode, onValue, placeholder, resolved, tone, negative }: {
  label: string; hint: string;
  mode: 'pct' | 'amt'; value: string;
  onMode: (m: 'pct' | 'amt') => void;
  onValue: (v: string) => void;
  placeholder: string; resolved: number; tone: string; negative?: boolean;
}) {
  const name = label.replace(/\s+/g, '-').toLowerCase();
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span className="text-xs font-medium text-[#6B5744] min-w-[120px]">
        {label}
        <span className="block text-[10px] font-normal text-[#8B7355]">{hint}</span>
      </span>
      <div className="flex items-center gap-2">
        {(['pct', 'amt'] as const).map(m => (
          <label key={m} className="flex items-center gap-1 cursor-pointer">
            {/* name= groups each pair, so the two rows keep separate selections */}
            <input type="radio" name={name} checked={mode === m} onChange={() => onMode(m)} className="accent-[#af4408]" />
            <span className="text-xs text-[#6B5744]">{m === 'pct' ? 'By %' : 'By Amount'}</span>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-1">
        {mode === 'amt' && <span className="text-xs text-[#8B7355]">₹</span>}
        <input type="number" step="0.01" min="0" value={value}
               onChange={e => onValue(e.target.value)} placeholder={placeholder}
               className="w-24 px-2 py-1 bg-white border border-[#D4B896] rounded text-xs text-right" />
        <span className="text-xs text-[#8B7355]">{mode === 'pct' ? '%' : ''}</span>
      </div>
      <span className={`text-xs font-semibold ml-auto ${tone}`}>
        {negative && resolved > 0 ? '− ' : ''}{fmt(resolved)}
      </span>
    </div>
  );
}

function ReceiveModal({ poId, role, onClose, onReceived }: {
  poId: string; role: 'admin' | 'manager'; onClose: () => void; onReceived: () => void;
}) {
  const [po, setPo] = useState<PO | null>(null);
  const [items, setItems] = useState<POItem[]>([]);
  const [overrides, setOverrides] = useState<Record<string, { quantity: number; unit_price: number }>>({});
  const [receivedAt, setReceivedAt] = useState<string>(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  /* Per-line "why does this differ from the PO" reason. (There is no longer a
     per-line rate LOCK — see the note above canEditRate.) */
  const [reasons, setReasons] = useState<Record<string, string>>({});
  /* RAW keystrokes for the rate box, per line. The committed rate lives in
     `overrides` as a NUMBER, but a controlled number input fed straight from it
     is untypeable: `<input type="number">` reports "" for a half-typed "900.",
     which parses to NaN → 0, so the field wipes itself the moment the receiver
     reaches the decimal point. That was survivable while only an admin ever
     unlocked a rate; now every receiver types one. The draft holds the raw
     string, the number is committed only when the string parses, and the draft
     is dropped on reset so the box falls back to the committed value. */
  const [rateDraft, setRateDraft] = useState<Record<string, string>>({});
  /* GST — mirrors /purchases exactly. `billGstRate` is the bill-level DEFAULT
     every line inherits ('0' so a bill entered the way it always was books the
     same numbers); `lineGst[id]` is a per-line override where '' means "follow
     the bill". Both are RAW STRINGS in state and are parsed only inside the
     compute — Number()-ing a rate box on every keystroke is the same trap the
     rate draft above exists for. */
  const [billGstRate, setBillGstRate] = useState<string>('0');
  const [lineGst, setLineGst] = useState<Record<string, string>>({});
  /* COMPENSATION CESS %, per line, raw string — same storage discipline as
     lineGst above and for the same reason (a number input re-parsed on every
     keystroke eats the decimal point).
     There is NO bill-level cess counterpart to billGstRate, and that is
     deliberate: one vendor bill is normally one GST rate, but cess is
     item-specific — the aerated-drink cases on a bill carry it and the rest of
     the bill does not — so a bill-level default would seed cess onto lines that
     were never charged any. Here '' means simply "no cess on this line", never
     "follow the bill". */
  const [lineCess, setLineCess] = useState<Record<string, string>>({});
  /* po_item_id → why that line cannot come in through Central (the server's own
     centralFlowBlock message, from GET …/receive). These are TGBCL/liquor lines:
     they are taxed on the store's bill through excise / cess / TCS, never GST,
     so they are forced to 0% in the COMPUTE below — a rate typed against one
     would be tax that was never paid. */
  const [storeBlocked, setStoreBlocked] = useState<Record<string, string>>({});
  /* BILL CHARGES — entered once for the whole delivery, allocated per line by
     the server. Discount REDUCES cost (it is netted into the rate written to
     purchases.unit_price, which is what average_price averages); Delivery is
     RECORDED ONLY. The %/₹ mode is transient UI state and is never persisted —
     the client resolves it to rupees before posting, same as /purchases. */
  const [deliveryMode, setDeliveryMode] = useState<'pct' | 'amt'>('amt');
  const [deliveryValue, setDeliveryValue] = useState('');
  const [discountMode, setDiscountMode] = useState<'pct' | 'amt'>('amt');
  const [discountValue, setDiscountValue] = useState('');
  const [chargesNote, setChargesNote] = useState('');
  const [billNo, setBillNo] = useState('');
  const [billDate, setBillDate] = useState<string>(new Date().toISOString().slice(0, 10));
  /* ── ONE PO, MANY VENDORS, ONE BILL EACH ────────────────────────────────
     A PO here is an internal approval document, so it legitimately spans
     several vendors — each of whom turns up on their own day with their own
     invoice. Receiving is therefore PER VENDOR: this modal books ONE vendor's
     lines at a time, under that vendor's bill number, bill date and charges.
     `stakes` comes from GET /api/purchase-orders/:id/receive, which is the only
     endpoint that knows which lines are already in (the receipt ledger is
     derived from the GRN rows, and a mixed PO now has one GRN per vendor —
     more than purchase_orders.grn_id can describe). */
  const [stakes, setStakes] = useState<VendorStake[]>([]);
  const [vendorKey, setVendorKey] = useState<string | null>(null);
  /* At least one vendor was booked in this session, so the list behind the
     modal is stale even if the PO is still open — dismissing must refetch it. */
  const [didReceive, setDidReceive] = useState(false);
  /* Lines the receiver has taken OFF this bill because the vendor is sending
     them later, on another invoice. NOT the same as receiving them at qty 0 —
     that books them as received-and-short for good, while these simply stay
     outstanding and keep the PO open. */
  const [excluded, setExcluded] = useState<Record<string, boolean>>({});

  /* WHO MAY TYPE A LINE'S RATE — now: anyone who may receive.
   *
   * The rate typed here is still written to purchases.unit_price and then through
   * updateMaterialPrice into raw_materials.average_price — i.e. into the cost of
   * every recipe that uses the material. That has not changed, and it is why the
   * rate used to be admin-only.
   *
   * What changed is the OWNER'S RULING: the bill is the bill. The PO rate was an
   * estimate agreed before the goods moved; the vendor's invoice is what was
   * actually charged. Locking the box did not make the number right — it made
   * the storekeeper either wait for an admin to walk to the receiving bay, or
   * book a rate everybody present knew was wrong.
   *
   * The control the lock carried is NOT removed, it is TRADED: a rate that
   * differs from the PO still demands a typed deviation_reason (see the
   * `deviations` memo), still raises the admin alert server-side, and is now
   * spelled out on the row at the moment the number is typed. Visibility and a
   * mandatory reason, instead of a stoppage. Weakening the reason gate to smooth
   * this out would turn it into an unaudited licence to rewrite agreed prices —
   * so the gate below is untouched. */
  const canEditRate: boolean = true;
  /* ADMIN, for the money gates that are NOT the rate. `role` comes from
   * /api/purchase-orders' viewer_role (effectiveRole(), which collapses staff →
   * 'manager'), so admin is the only tier this response can distinguish. It now
   * governs one thing here: the cap on how large a discount a non-admin may book
   * (NON_ADMIN_DISCOUNT_CAP_PCT), which the receive route enforces too. */
  const isAdmin = role === 'admin';

  /* Load (or reload) the PO and its vendor stakes. Called on mount and again
     after each vendor is booked, so a receiver who takes two deliveries in one
     sitting always sees the ledger as it now stands rather than a cached copy
     that still lists vendor A as outstanding. */
  const load = useCallback(async (keepVendor?: string | null) => {
    setLoading(true);
    // `.catch(() => ({}))` alone swallowed a non-OK response as well as a network
    // failure: a 403/500 from either endpoint parsed to {}, and the modal then
    // rendered a PO with NO vendor stakes — which reads as "nothing received yet"
    // and invites the receiver to book a delivery twice. A failed load must look
    // like a failure, so a non-OK status is turned into a throw and surfaced.
    const [detail, recv] = await Promise.all([
      fetch(`/api/purchase-orders?id=${poId}`).then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status)))).catch(() => null),
      fetch(`/api/purchase-orders/${poId}/receive`).then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status)))).catch(() => null),
    ]);
    if (!detail || !recv) {
      setLoading(false);
      alert('Could not load this purchase order. Reload the page before receiving — booking a delivery against a half-loaded PO can double-count it.');
      return;
    }
    setPo(detail.purchase_order || null);
    const its: POItem[] = detail.purchase_order?.items || [];
    setItems(its);
    const map: Record<string, { quantity: number; unit_price: number }> = {};
    for (const it of its) map[it.id] = { quantity: it.quantity, unit_price: it.unit_price };
    setOverrides(map);
    // Every per-line and per-bill entry belongs to ONE vendor's delivery — none
    // of it may carry over to the next vendor, so it is cleared with the reload.
    setReasons({}); setRateDraft({}); setExcluded({});
    setBillNo(''); setChargesNote('');
    setDiscountValue(''); setDeliveryValue('');
    setDiscountMode('amt'); setDeliveryMode('amt');
    // Tax belongs to the vendor's bill, not to the PO — the next vendor's bill
    // starts at the 0% default. (The per-line rates are seeded from the master
    // further down, once the store/TGBCL verdict is in hand.)
    setBillGstRate('0');
    // The server's own verdict on which lines are store/TGBCL materials. Read
    // from the payload rather than re-derived from categories here: the receive
    // route decides this with centralFlowBlock, and a second client-side guess
    // is how one screen taxes a bottle the other zero-rates.
    const sb: Record<string, string> = {};
    for (const b of (Array.isArray(recv?.store_blocked) ? recv.store_blocked : [])) {
      if (b?.po_item_id) sb[String(b.po_item_id)] = String(b.error || 'store item — taxed on the TGBCL bill');
    }
    setStoreBlocked(sb);
    /* SEED each line's GST% from raw_materials.tax_percent (delivered as
       material_tax_percent by the PO detail API). Until now the master's Tax %
       was a write-only field — nothing in the purchase / PO / GRN flow ever read
       it, so a rate typed on the master never reached a bill and cgst/sgst were
       never written on anything.
         SEED, NOT FORCE. A bill is a fact: the printed vendor invoice wins over
       the master, so this only fills the select and the receiver may change it.
       A line with no seed keeps '' = follow the bill's rate.
         ORDER MATTERS — this must stay BELOW setStoreBlocked/`sb`. A store/TGBCL
       line is zero-rated unconditionally (liquor is taxed on the store's own
       bill), and while billCalc's zero_rated short-circuit would discard a rate
       anyway, writing one into lineGst would show a rate the server then throws
       away, and would surface for real if the store mapping ever changed. Never
       hoist this back up beside the setBillGstRate reset.
         The GST_RATES membership test is not decoration: the master accepts any
       number, and a rate with no matching <option> renders the select blank
       while the compute books the rate — the receiver would read 0% and sign a
       28% bill. Anything off the list falls back to follow-the-bill. */
    const gseed: Record<string, string> = {};
    for (const it of its) {
      if (sb[String(it.id)]) continue;
      const t = Number(it.material_tax_percent) || 0;
      const s = String(t);
      if (t > 0 && (GST_RATES as readonly string[]).includes(s)) gseed[it.id] = s;
    }
    setLineGst(gseed);
    /* …and SEED each line's COMPENSATION CESS % from raw_materials.cess_percent
       (delivered as material_cess_percent by the same PO detail API). This used
       to be the one half that could not be done: Receive books tax onto
       goods_receipt_note_items, and that table carried no compensation-cess
       column, so a rate seeded here had nowhere to land. It has one now — the
       eighth charge on the GRN item — so the master's Cess % finally reaches a
       bill, which is the whole of the reported gap.
         Every rule above applies unchanged: SEED, NOT FORCE (the printed vendor
       bill wins, so the receiver may retype it), and this must stay BELOW
       setStoreBlocked/`sb` for exactly the same reason — a store/TGBCL line's
       cess is levied on the store's own bill, so seeding one here would show a
       rate the compute then throws away.
         ONE DELIBERATE DIFFERENCE from the GST seed above: there is no GST_RATES
       membership test. That test exists only because GST is a <select>, where a
       value matching no <option> renders blank while the compute books the rate.
       The cess control below is a free number input mirroring the master's own
       free 0-100 field, so any in-range value renders honestly and refusing e.g.
       12.5 would silently drop real money. Only non-finite / <=0 / >100 are
       refused — the same test seedCessForMaterial applies on /purchases.
         Like setLineGst above, this REPLACES the map wholesale, so it is also
       the per-vendor clear: the next vendor's bill starts from their own lines'
       seeds and nothing carries over. */
    const cseed: Record<string, string> = {};
    for (const it of its) {
      if (sb[String(it.id)]) continue;
      const c = Number(it.material_cess_percent);
      if (!Number.isFinite(c) || c <= 0 || c > 100) continue;
      cseed[it.id] = String(c);
    }
    setLineCess(cseed);
    const list: VendorStake[] = Array.isArray(recv?.vendors) ? recv.vendors : [];
    setStakes(list);
    // Auto-select the vendor still owing goods when there is only one — that is
    // the single-vendor PO, and it must feel exactly as it always has.
    const open = list.filter(v => !v.done);
    setVendorKey(
      keepVendor && open.some(v => v.key === keepVendor) ? keepVendor
      : open.length === 1 ? open[0].key
      : null,
    );
    setLoading(false);
  }, [poId]);

  useEffect(() => { void load(); }, [load]);

  /** The vendor whose delivery is on the table right now. */
  const stake = useMemo(() => stakes.find(v => v.key === vendorKey) || null, [stakes, vendorKey]);
  const openStakes = useMemo(() => stakes.filter(v => !v.done), [stakes]);
  const isMultiVendor = stakes.length > 1;
  /* WHOSE delivery is being booked, in words, for the header and the strip.
   * `stake` is null while the PO is still loading AND on a multi-vendor PO
   * before the receiver picks, so every step is optional-chained — reading
   * stake.vendor_name straight would blank the whole modal.
   * The single-stake fallback covers the ordinary one-vendor PO in the tick
   * before load() auto-selects it. It is deliberately NOT taken when the PO
   * spans several vendors: naming vendor A while the receiver is about to book
   * vendor B is precisely the mix-up this is here to prevent, and there the
   * header vendor ("Mixed (N vendors)") is the honest answer. */
  const vendorLabel = useMemo(
    () => (stake?.vendor_name || (stakes.length === 1 ? stakes[0]?.vendor_name : '') || po?.vendor || '').trim(),
    [stake, stakes, po],
  );
  /* THE LINES THIS RECEIPT COVERS — this vendor's still-outstanding ones, and
     nothing else. Lines another vendor owes, and lines already received, are not
     rendered at all: a row on screen is a row that will be booked. */
  const visibleItems = useMemo(() => {
    if (!stake) return [];
    const allow = new Set(stake.line_ids);
    return items.filter(it => allow.has(it.id));
  }, [items, stake]);

  const setQty   = (id: string, v: number) => setOverrides(o => ({ ...o, [id]: { ...o[id], quantity: v } }));
  const setPrice = (id: string, v: number) => setOverrides(o => ({ ...o, [id]: { ...o[id], unit_price: v } }));

  /* ── THE ONE DEFINITION OF "THIS LINE DEVIATES" ───────────────────────────
   * A line deviates when the received qty differs from the ordered qty (short OR
   * excess) or the effective rate differs from the ordered rate. Every deviating
   * line needs a typed reason and raises an admin alert server-side.
   * The row hint, the blocking banner, the disabled Confirm button and the
   * submitted item_overrides all read THIS memo, so they can never disagree
   * about which lines are deviating (the payload filter used to be a separate
   * copy of the same predicate).
   * Qty and rate here are PURCHASE units / ₹ per purchase unit — never the
   * recipe unit — so every number is labelled with material_purchase_unit.
   * The tolerances are the receive route's own (QTY_EPS 1e-6, RATE_EPS 0.005 —
   * receive/route.ts), so a line this screen demands a reason for is exactly a
   * line the server would refuse without one: an exact `!== 0` here blocked
   * Confirm on ₹900.002 vs ₹900, which the route treats as no change at all. */
  const deviations = useMemo(() => visibleItems.map(it => {
    const ov = overrides[it.id] || { quantity: it.quantity, unit_price: it.unit_price };
    const qty       = Number(ov.quantity);
    const price     = Number(ov.unit_price);
    const qtyDiff   = qty - it.quantity;
    const priceDiff = price - it.unit_price;
    const qtyOff    = Math.abs(qtyDiff) > QTY_EPS;
    const rateOff   = Math.abs(priceDiff) > RATE_EPS;
    const u = (it as any).material_purchase_unit || (it as any).material_unit || '';
    // Pack meta rides along so every qty cell on the row can print its recipe
    // hint from ONE resolution — a per-cell re-derivation is how "Ordered 10 kg"
    // ended up beside a sibling reading grams.
    const meta = packMetaOf(it);
    const bits: string[] = [];
    if (qtyOff) {
      bits.push(`${qtyDiff > 0 ? 'excess' : 'short'} ${qfmt(Math.abs(qtyDiff))}${u ? ' ' + u : ''} ` +
                `(received ${qfmt(qty)}${u ? ' ' + u : ''} vs ordered ${qfmt(it.quantity)}${u ? ' ' + u : ''})`);
    }
    if (rateOff) {
      bits.push(`rate ₹${price.toFixed(2)}${u ? '/' + u : ''} vs ordered ₹${it.unit_price.toFixed(2)}${u ? '/' + u : ''}`);
    }
    return { it, ov, qtyDiff, priceDiff, qtyOff, rateOff, u, meta,
             // ON this bill? An excluded line is still rendered (so it can be
             // put back) but is not received, not costed and not reasoned about.
             included: !excluded[it.id],
             deviates: bits.length > 0, label: bits.join(' · ') };
  }), [visibleItems, overrides, excluded]);

  /* THE LINES THIS BILL ACTUALLY BOOKS. Every downstream number — the reason
     gate, both totals, the charge allocation and the posted payload — reads
     this one list, so an excluded line can never leak into any of them. */
  const activeDeviations = useMemo(() => deviations.filter(d => d.included), [deviations]);

  // Free text, trimmed, ≥ 3 chars — same floor the receive route enforces, so a
  // reason the server would reject can never look accepted here.
  const MIN_REASON = 3;
  const missingReason = activeDeviations.filter(d => d.deviates && (reasons[d.it.id] || '').trim().length < MIN_REASON);
  const missingList = (prefix: string) =>
    prefix + missingReason.map(d => `• ${d.it.material_name} — ${d.label}`).join('\n');

  /* Both totals cover THIS VENDOR'S lines on THIS bill — the footer sits under
     their rows and is the figure their invoice has to reconcile to. Summing the
     whole PO here would show a receiver a number no invoice in their hand could
     ever match. */
  // BOTH halves of both products share a basis; no conversion needed.
  // `d.ov` defaults to `{ quantity: it.quantity, unit_price: it.unit_price }`
  // (the deviations memo) and is otherwise whatever setQty/setPrice wrote from
  // the two receive-screen inputs, which render `{u}` and `/{u}` where
  // u = material_purchase_unit — so ov is billed PURCHASE units at Rs per
  // purchase unit. `d.it` is a purchase_order_items row: quantity = PURCHASE
  // units, unit_price = Rs/purchase-unit by canon. These are the same two
  // numbers POST /receive multiplies for acceptedTotal, so this footer and the
  // booked bill agree by construction.
  // rate-basis: purchase (billed PURCHASE units x Rs/purchase-unit)
  const total = activeDeviations.reduce((s, d) =>
    s + (Number(d.ov.quantity) || 0) * (Number(d.ov.unit_price) || 0), 0);
  // rate-basis: purchase — purchase_order_items quantity x unit_price, as ordered.
  const orderedTotal = activeDeviations.reduce((s, d) => s + d.it.quantity * d.it.unit_price, 0);

  /* ZERO-RATED LINES. A store/TGBCL material carries excise, cess and TCS on the
     store's own bill and no GST at all, so it can never take a rate here. The
     receive route already refuses to bring these into Central stock, which is
     why they are normally not even rendered (they sit in blocked_line_ids, not
     line_ids) — this set is belt-and-braces for any payload that still shows
     one, and it is applied in the COMPUTE, not just the UI, so a rate left over
     from a swapped material cannot leak tax into the bill. */
  const storeZeroRated = useMemo(() => {
    const s = new Set<string>(Object.keys(storeBlocked));
    for (const id of (stake?.blocked_line_ids || [])) s.add(String(id));
    return s;
  }, [storeBlocked, stake]);

  /* The bill preview runs the SAME allocator the route runs, on the SAME
     effective numbers the deviations memo uses — so the figure the receiver
     confirms is the figure that gets booked.
     …and then GST, per line, in this order (identical to /purchases' billCalc,
     because a bill must cost the same whichever screen books it):
        goods   = qty × rate
        taxable = goods − that line's share of the bill discount
        tax     = taxable × gst%
        cgst + sgst = tax, with the odd paisa in CGST
        cess    = goods × cess%   ← the GROSS, not `taxable`. See below.
     THE TWO TAXABLE BASES ARE DIFFERENT ON PURPOSE. GST is charged on the
     POST-discount value; compensation cess is charged on the GROSS line value,
     BEFORE the discount. That is the owner's ruling, and the receive route
     computes it off its own `grossTotal` for the same reason — collapsing the
     two into one base to "tidy" this would under-charge cess on every
     discounted bill and put the screen at odds with the server.
     TAX IS CARRIED ALONGSIDE THE GOODS RATE AND NEVER INSIDE IT. Input GST is
     reclaimable credit, not part of what the food costs: fold it into the rate
     and average_price — and every recipe cost derived from it — inflates by the
     GST rate, silently and forever. That is exactly the bug the old bill-level
     GST control caused, which is why nothing below touches unit_price,
     net_rate, or either of the two goods totals. */
  const billCalc = useMemo(() => {
    const chargeLines = activeDeviations.map(d => ({
      id: d.it.id, name: d.it.material_name,
      qty: Number(d.ov.quantity) || 0, rate: Number(d.ov.unit_price) || 0,
    }));
    const subtotal = chargeLines.reduce((s, l) => s + (l.qty > 0 && l.rate > 0 ? l.qty * l.rate : 0), 0);
    const discount = resolveCharge(discountMode, discountValue, subtotal);
    const delivery = resolveCharge(deliveryMode, deliveryValue, subtotal);
    const allocation = allocateBillCharges(chargeLines, { discount, delivery });

    // The bill-level rate is a DEFAULT lines inherit. Parsed here, once — the
    // selects hold raw strings so nothing round-trips through Number() mid-edit.
    const billRate = parseFloat(billGstRate) || 0;
    /* The discount share is taken from the allocator's own line, never
       re-derived: the allocator gives the LAST allocatable line the remainder so
       the shares sum to the bill exactly, and a second proportional calculation
       here would disagree with it by a paisa on most bills. `net_total` is
       already gross − discount_share, which is the taxable value. */
    const byId = new Map<string, {
      zero_rated: boolean; zero_reason: string; rate: number; discount_share: number;
      taxable: number; tax_value: number; cgst: number; sgst: number; incl_tax: number;
      cess_rate: number; compensation_cess: number; gross: number;
    }>();
    for (const l of allocation.lines) {
      const zeroRated = storeZeroRated.has(l.id);
      const raw = lineGst[l.id];
      const rate = zeroRated ? 0 : ((raw == null || raw === '') ? billRate : (parseFloat(raw) || 0));
      const taxable = r2(l.net_total);
      const taxValue = r2(taxable * rate / 100);
      /* House invariant: tax_value = cgst + sgst. INTEGER PAISE, and the odd
         paisa lands in CGST — byte-identical to /purchases and to the server
         (api/purchases: sgstPaise = floor(taxPaise / 2), cgst = remainder).
         Rounding both halves independently overshoots by a paisa on an odd
         amount (₹1.01 → 0.51 + 0.51), and putting the spare paisa in SGST makes
         the screen and the stored row disagree — totals still match, so nothing
         looks wrong until someone reconciles a GST return line by line. */
      const taxPaise = Math.round(taxValue * 100);
      const sgst = Math.floor(taxPaise / 2) / 100;
      const cgst = r2(taxValue - sgst);

      /* GST COMPENSATION CESS — a SEPARATE levy on a DELIBERATELY DIFFERENT
         BASE. Read this before "simplifying" the two bases into one:
             GST  is charged on `taxable` = l.net_total = gross − discount share
             CESS is charged on `l.gross` = qty × rate, BEFORE any discount
         On the owner's own worked example — 10 kg @ ₹100 = ₹1,000 with a ₹100
         bill discount — GST 18% is ₹162 on ₹900 while cess 12% is ₹120 on
         ₹1,000. Moving cess onto `taxable` would quietly under-charge it on
         every discounted bill AND disagree with the receive route, which
         derives it from its own `grossTotal` for exactly this reason.
         `l.gross` is the allocator's own figure, not a second multiplication:
         the allocator hands the last line the discount remainder, so a re-derived
         gross here could differ by a paisa on some bills. Because cess is taken
         BEFORE the discount, no allocation rounding can move it at all.
         NOT halved and NOT added into cgst/sgst: tax_value = cgst + sgst is the
         figure a GST return is filed on, and cess is not GST (nor is it input
         credit against GST — only against cess output liability), so no label
         may fold it in. RECORDED ONLY, like delivery: it never touches
         unit_price, net_rate, average_price or any recipe cost.
         Whole paise, byte-identical in shape to the server's expression — the
         ÷100 for percent and the ×100 for paise cancel, which is why there is
         no /100 in sight. Same zero-rate lock as GST: a store/TGBCL line's cess
         is levied on the store's own bill, never on ours. */
      // rate-basis: purchase — `l.gross` is the allocator's PURCHASE-unit qty ×
      // Rs/purchase-unit; `cessRate` is a PERCENT, not a per-unit rate, so it
      // carries no basis of its own and cannot disagree with that quantity.
      const cessRate = zeroRated ? 0 : (parseFloat(lineCess[l.id] ?? '') || 0);
      const cessPaise = cessRate > 0 ? Math.max(0, Math.round(l.gross * cessRate)) : 0;
      const compensationCess = cessPaise / 100;

      byId.set(l.id, {
        zero_rated: zeroRated,
        zero_reason: storeBlocked[l.id] || 'store item — taxed on the TGBCL bill, not GST',
        // Carried so the row can SAY the taxable value is net of a discount,
        // without comparing two floats that differ only by rounding.
        discount_share: l.discount_share,
        rate, taxable, tax_value: taxValue, cgst, sgst, incl_tax: r2(taxable + taxValue),
        // The CESS base, carried so the row can NAME it. Kept distinct from
        // `taxable` on purpose — a reader who sees only one base will assume
        // both levies share it, which is the mistake this whole block guards.
        gross: l.gross,
        cess_rate: cessRate, compensation_cess: compensationCess,
      });
    }
    const cgstTotal = r2([...byId.values()].reduce((s, t) => s + t.cgst, 0));
    const sgstTotal = r2([...byId.values()].reduce((s, t) => s + t.sgst, 0));
    const taxTotal  = r2(cgstTotal + sgstTotal);
    // Kept OUT of taxTotal on purpose — see the per-line note above. taxTotal is
    // the GST figure and must stay exactly the GST figure.
    const cessTotal = r2([...byId.values()].reduce((s, t) => s + t.compensation_cess, 0));
    // Goods − discount, computed ONCE rather than summed from the per-line
    // shares (those can drift a paisa on rounding). This is the figure printed
    // on the paper bill in the receiver's hand. It is the GST base only: cess
    // is charged on the goods subtotal above it, before the discount.
    const taxableTotal = r2(allocation.subtotal - allocation.discount_applied);
    // What is actually owed the vendor: goods, less discount, plus their tax,
    // plus compensation cess, plus delivery. Cess belongs here — the vendor
    // really does charge it — even though it is held out of taxTotal. Tax, cess
    // and delivery are all on the bill but NOT in the cost of the goods — that
    // stays `net_subtotal`.
    const billTotal = r2(taxableTotal + taxTotal + cessTotal + allocation.delivery);
    // GST-only, deliberately: this is the sum of the per-line Incl. Tax column,
    // and that column is taxable + GST. Cess is shown on its own line instead of
    // being buried inside a column headed "Incl. Tax".
    const inclTaxTotal = r2(taxableTotal + taxTotal);
    return {
      alloc: allocation, discount, delivery,
      tax: { byId, cgstTotal, sgstTotal, taxTotal, cessTotal, taxableTotal, billTotal, inclTaxTotal },
    };
  }, [activeDeviations, discountMode, discountValue, deliveryMode, deliveryValue,
      billGstRate, lineGst, lineCess, storeZeroRated, storeBlocked]);

  const alloc = billCalc.alloc;
  const tax = billCalc.tax;
  const hasCharges = alloc.discount_applied > 0 || alloc.delivery > 0;
  // A discount changes what stock cost — it needs the same "say why" discipline
  // as an off-PO line, and the server enforces the identical floor.
  const needsChargeNote = alloc.discount_applied > 0 && chargesNote.trim().length < MIN_REASON;
  // > cap + half a paisa — the same headroom the route uses, so an exactly-25%
  // discount is not refused here while the server would accept it.
  const overDiscountCap = !isAdmin && alloc.subtotal > 0
    && alloc.discount_applied - (alloc.subtotal * NON_ADMIN_DISCOUNT_CAP_PCT) / 100 > 0.005;
  const zeroCost = alloc.zero_cost_lines;
  const chargeBlockers: string[] = [
    ...(needsChargeNote ? ['Say why the vendor gave the discount (min 3 characters).'] : []),
    ...(overDiscountCap ? [`A discount above ${NON_ADMIN_DISCOUNT_CAP_PCT}% of the bill needs an admin to receive.`] : []),
    ...(zeroCost.length > 0 ? [`The discount is bigger than these lines are worth: ${zeroCost.map(l => l.name).join(', ')}.`] : []),
    ...(alloc.subtotal <= 0 && hasCharges ? ['Nothing is being accepted, so there is nothing to apply the bill charges to.'] : []),
  ];

  /* Dismissing the modal. If any vendor was booked in this session the PO list
     behind it is stale (its total, and possibly its status, moved), so Cancel
     has to refetch — onReceived() is the callback that does. */
  const dismiss = () => { if (didReceive) onReceived(); else onClose(); };

  const submit = async () => {
    // No vendor chosen on a mixed PO — the route refuses this outright (one
    // bill number cannot cover three vendors' goods); say so before the trip.
    if (!stake) {
      alert('Pick which vendor is delivering. Each vendor on this PO is received separately, under their own bill number.');
      return;
    }
    // Belt-and-braces with the disabled button: the reason gate must not be
    // skippable by a stale click. (The receive route re-checks it anyway — that
    // is the real gate; this is only so the receiver gets a readable message.)
    if (activeDeviations.length === 0) {
      alert('Tick at least one line to put on this bill.');
      return;
    }
    if (missingReason.length > 0) {
      alert(missingList('Add a reason for these lines before receiving:\n'));
      return;
    }
    // Same belt-and-braces as the reason gate — the route re-checks every one of
    // these; this is only so the receiver gets a readable message.
    if (chargeBlockers.length > 0) {
      alert('Fix the bill charges before receiving:\n' + chargeBlockers.map(b => `• ${b}`).join('\n'));
      return;
    }
    setSaving(true);
    try {
      // Every deviating line is sent, carrying the reason the receiver typed as
      // deviation_reason (why it differs from the PO). rejection_reason stays
      // what it always was: QC, why units were rejected. `deviating` is also
      // what the post-commit notes below count, so it stays the deviation set
      // and nothing else.
      const deviating = activeDeviations.filter(d => d.deviates);
      /* …plus any line that carries TAX, deviating or not: gst_rate and
         cess_rate are per line on the wire (there is no bill-level tax field),
         so a taxed line that matches its PO exactly still has to say so or its
         tax is lost. CESS COUNTS ON ITS OWN: a line with 12% cess and no GST at
         all — which is a real bill, cess is item-specific — must still be sent,
         or the cess is silently dropped. A line at 0% on BOTH is left out: an
         absent rate and an explicit 0 mean the same thing to the server, so on a
         bill with no GST and no cess this payload is byte-identical to the one
         this screen has always sent. */
      const taxedOrDeviating = activeDeviations.filter(d => {
        const t = billCalc.tax.byId.get(d.it.id);
        return d.deviates || (t?.rate || 0) > 0 || (t?.cess_rate || 0) > 0;
      });
      const item_overrides = taxedOrDeviating.map(d => {
        const t = billCalc.tax.byId.get(d.it.id);
        return {
          po_item_id: d.it.id,
          // THE GOODS RATE, still. Tax rides in its own fields below and is
          // never folded into this number — it is what becomes
          // purchases.unit_price → average_price → every recipe cost.
          quantity: d.ov.quantity,
          unit_price: d.ov.unit_price,
          deviation_reason: (reasons[d.it.id] || '').trim(),
          // Percent (0 | 5 | 12 | 18); 0 = exempt or a store/TGBCL line. The
          // server RE-DERIVES the tax from (line value − discount share) × this
          // rate and stores its own figure — cgst/sgst travel only so a mismatch
          // between the two is detectable rather than silent.
          gst_rate: t?.rate ?? 0,
          cgst: t?.cgst ?? 0,
          sgst: t?.sgst ?? 0,
          // COMPENSATION CESS — the PERCENT only, never a rupee figure. Unlike
          // cgst/sgst there is no legacy client posting a cess amount here, so
          // the server reads the rate and derives the money itself off its own
          // GROSS line value (before discount, the opposite base to GST). A ₹
          // figure on the wire could only ever be a second opinion this row's
          // goods value cannot justify, so none is sent.
          cess_rate: t?.cess_rate ?? 0,
        };
      });
      const r = await api(`/api/purchase-orders/${poId}/receive`, {
        method: 'POST',
        body: {
          received_at: receivedAt, item_overrides,
          // WHICH VENDOR is delivering. Only their outstanding lines are booked,
          // and the bill below is filed against them alone.
          vendor_key: stake.key,
          // …and WHICH of their lines are on THIS bill. Always sent, so the
          // server's scope is exactly the set of rows on screen; anything the
          // receiver took off stays outstanding and keeps the PO open.
          line_ids: activeDeviations.map(d => d.it.id),
          // Rupees, resolved from the %/₹ toggle here. The server re-allocates
          // from its own effective line values — it never trusts these shares.
          // bill_charges is the ONLY carrier for bill_date, so gate it on the
          // date too: a receiver who only corrects the vendor's invoice date (no
          // discount, no delivery, no bill no.) would otherwise post nothing and
          // the route would file the bill under received_at instead.
          bill_charges: hasCharges || billNo.trim() || chargesNote.trim() || billDate !== receivedAt ? {
            // Mode + raw value travel WITH the resolved rupees: this preview
            // sums every PO line, but the route allocates only over the lines it
            // actually receives (store-mapped ones are dropped), so a "5%" here
            // could land as 10% there. The route re-resolves a percentage
            // against its own base; the ₹ figure covers By-Amount + old clients.
            discount_mode: discountMode, discount_value: Number(discountValue) || 0,
            delivery_mode: deliveryMode, delivery_value: Number(deliveryValue) || 0,
            discount_amount: alloc.discount_applied,
            delivery_amount: alloc.delivery,
            charges_note: chargesNote.trim(),
            bill_no: billNo.trim(),
            // The VENDOR'S invoice date — routinely older than the day the truck
            // arrived, so it is recorded separately from received_at.
            bill_date: billDate,
          } : undefined,
        },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert(j.error || 'Failed');
        // 409 = this delivery is already in (someone else received the PO, or
        // this vendor's lines, or this exact bill number). Either way what is on
        // screen is stale, so close + refetch rather than leave a Confirm button
        // that can only fail again.
        if (r.status === 409) { setDidReceive(true); onReceived(); }
        return;
      }
      setDidReceive(true);

      /* ── THE DELIVERY IS HELD FOR A QUALITY CHECK — SAID FIRST, AND ALWAYS ──
         20 of the live GRNs come through THIS route, and until now it was the
         one that said nothing: the receive route has always returned
         qc_required / qc_message / qc_checker / qc_notified (see its own note,
         "A silent hold at the bay is the one way this feature could make things
         worse"), and this screen read none of them.

         The silence was total, not partial. On a clean 12-line vegetable PO —
         no deviation, no excess, no bill discount, and 193 of the 194 materials
         in the gated categories carry tax_percent = 0, so the GST note does not
         fire either — `notes` stayed empty, `complete` was true and
         `isMultiVendor` false, so the whole alert chain below fell through in
         silence and the modal simply closed onto a PO reading "received". The
         storekeeper waved the truck off having been told nothing, and the goods
         were still the vendor's to take back for the only few minutes that
         mattered. On a multi-vendor PO it was worse than silence: the last
         branch cheerfully alerted "Vendor received — PO is now complete."

         So this fires BEFORE the store-blocked, deviation, GST and completion
         alerts rather than joining them: those are things to read afterwards;
         this one is a thing to DO while the driver is still standing there.
         It also seeds `notes` below, which makes the silent fall-through
         structurally impossible whichever completion branch is taken. */
      if (j.qc_required) {
        const who = j.qc_checker === 'bar' ? 'Bar'
          : j.qc_checker === 'both' ? 'Kitchen or Bar' : 'Kitchen';
        const told = Array.isArray(j.qc_notified) ? j.qc_notified.length : 0;
        alert([
          `⏸  NO STOCK HAS BEEN ADDED — GRN ${j.grn_number || ''} is waiting for a ${who} quality check.`,
          j.qc_message
            || `${who} must check quality, temperature and damage and sign off before these goods enter stock.`,
          'KEEP THE VENDOR AT THE BAY until they do. Once the check is signed the goods are ours and they cannot be sent back.',
          told > 0
            ? `${told} person(s) have been notified and it is on the bell.`
            : 'Nobody could be notified automatically — tell the kitchen yourself.',
          'Clear it at Purchasing → Pending Quality Checks. An admin or head chef can release it without a check, with a written reason.',
        ].filter(Boolean).join('\n\n'));
      }

      // Store-mapped (liquor) lines are SKIPPED by the receive route so they
      // never touch Central stock — but the "Receive total" the receiver just
      // confirmed counted them, so name the lines that did NOT arrive.
      if (Array.isArray(j.store_blocked) && j.store_blocked.length > 0) {
        alert(
          `${j.store_blocked.length} line(s) were NOT received:\n` +
          j.store_blocked.map((b: any) => `• ${b.material_name} — ${b.error}`).join('\n') +
          '\n\nThese must be procured through Inventory → Liquor Store instead.'
        );
      }
      // Off-PO acknowledgement — show the receiver that the admin has been
      // notified (audit_event + in-app notification + optional Slack).
      // Excess and short/rate are NOT alternatives: a mixed receive is 1 line
      // over AND 2 short. These used to be if/else-if, so the excess line
      // swallowed the confirmation for exactly the short lines the receiver had
      // just been forced to justify. One alert, both facts.
      const notes: string[] = [];
      // Repeated here, in one line, so that whichever completion alert fires it
      // cannot end on the word "received" with no mention of the hold — and so
      // the "clean receive stays silent" branch can never be reached on a held
      // delivery. The full instruction was already given above.
      if (j.qc_required) {
        notes.push(
          `NOTE: no stock was added — GRN ${j.grn_number || ''} is awaiting a ` +
          `${j.qc_checker === 'bar' ? 'Bar' : j.qc_checker === 'both' ? 'Kitchen or Bar' : 'Kitchen'} ` +
          'quality check. The PO is recorded; the goods are not ours until it is signed off.'
        );
      }
      /* ── THE SILENT CASE, MADE AUDIBLE ────────────────────────────────────
         GRN-2026-0018 came in through THIS route: SUGUNA FOODS, 90 kg chicken
         leg boneless and 30 kg whole bird, inwarded instantly. The gate was not
         broken — POULTRY simply had no row in the map, so it answered "not
         required" exactly as designed. What was broken is that this screen then
         said nothing at all, and a perishable category nobody had ruled on
         looked identical to a working quality-check process.

         It rides in `notes` rather than in an alert() of its own, and that is
         deliberate on both counts. It is NOT a thing to do while the driver is
         standing there — the stock is in, the receipt is complete, there is
         nothing to hold the truck for — so it must not jump ahead of the
         qc_required alert above, which is. But it also must never be swallowed:
         seeding `notes` makes the `else if (notes.length > 0)` branch fire, so
         the "clean receive stays silent" path below is structurally unreachable
         on a receipt like this one. That silence is the whole defect.

         Undecided ONLY — the server keys this on a category having NO rule at
         all, never on "not gated". A category an admin has set to No check is a
         DECISION and says nothing here; widening it would mean a note on nearly
         every bill (grocery is on most of them), and a note on every bill is one
         the desk stops reading inside a week. */
      const undecidedCats: string[] = Array.isArray(j.qc_undecided_categories) ? j.qc_undecided_categories : [];
      if (undecidedCats.length > 0) {
        const many = undecidedCats.length > 1;
        /* CAPPED, like the server's own sentence. This lands in a native
           alert() with no layout: on a map that is present but empty every
           category on the bill is undecided, and the un-capped join produced a
           twenty-name wall that is read as far as the first comma. Three names
           and a count is a thing you finish reading. */
        const shownCats = undecidedCats.slice(0, 3);
        const catList = shownCats.join(', ')
          + (undecidedCats.length > shownCats.length ? ` and ${undecidedCats.length - shownCats.length} more` : '');
        /* TONE. This is a NOTE ON A COMPLETED RECEIPT, and the wording has to
           match that or it gets read as a failure the receiver caused. It used
           to open in capitals — "NO QUALITY CHECK WAS MADE on grocery." — with
           the reassurance 250 characters later, inside a native alert() that has
           no hierarchy to carry the difference. On a routine dry-goods bill that
           reads as an alarm about nothing, and an alarm about nothing on most
           bills is what teaches a desk to dismiss the one that matters. The
           other receiving screen (grn/page.tsx) already gets this right —
           success stated first, advisory second, a question-mark shield rather
           than a warning triangle — and the two screens should not disagree
           about how serious the same fact is. State the fact, then the stake. */
        notes.push(
          `${many ? 'These categories were' : 'This category was'} received with no quality check: ${catList}. ` +
          `Nobody has ever set a rule for ${many ? 'them' : 'it'}, ` +
          // ONE BILL CAN BE BOTH, and the two cases are opposite statements about
          // stock. On a receipt held for some OTHER category nothing has entered
          // stock at all yet — saying "went straight into stock" there would
          // contradict the alert this desk read thirty seconds ago and make both
          // messages untrustworthy. The undecided lines ride in with the rest the
          // moment the check above is signed, which is the true sentence.
          (j.qc_required
            ? `and ${many ? 'they are' : 'it is'} NOT what is holding this delivery. When the quality check above is signed off, `
              + `${many ? 'they go' : 'it goes'} into stock with everything else, unchecked. `
            : `so the goods went straight into stock unchecked. `) +
          `That is NOT the same as "no check needed" — nobody has decided either way. ` +
          `Nothing is wrong with this receipt and nothing needs re-entering. ` +
          `If ${many ? 'these are perishable' : 'this is perishable'} (meat, poultry, seafood, dairy), ask an admin to set the checker at ` +
          'Settings → Quality Check Categories — it applies from the very next delivery.'
        );
      }
      if (deviating.length > 0) {
        // Counted from what we SENT rather than a response field, so this stays
        // true whatever the route names its counters. Short qty and rate changes
        // raise the same admin alert as excess.
        notes.push(
          `${deviating.length} line(s) differed from the PO (qty and/or rate). ` +
          'The reason you gave has been recorded and the admin has been notified for review.'
        );
      }
      if (j.excess_lines > 0) {
        notes.push(
          `${j.excess_lines} line(s) were accepted OVER the ordered qty (${fmt(j.excess_value || 0)} excess) — ` +
          'recorded on /audit with the rest of this receive.'
        );
      }
      if (j.charges_applied && (j.charges_applied.discount_applied > 0 || j.charges_applied.delivery > 0)) {
        const c = j.charges_applied;
        notes.push(
          `Bill charges booked against ${j.vendor || 'this vendor'} only: discount ${fmt(c.discount_applied)} (reduced the cost of stock)` +
          `${c.discount_clamped ? ' — capped at the bill value' : ''}` +
          ` · delivery ${fmt(c.delivery)} (recorded against the bill, not added to item cost).` +
          ' No other vendor\'s lines on this PO were touched.'
        );
      }
      /* GST as the SERVER committed it, not as this screen computed it — the two
         differ by a paisa on half-paisa amounts, and by the whole amount on a
         line the server zero-rated as a store item. The receiver is signing off
         a tax figure, so they are shown the one that was actually stored. */
      if (j.tax_applied && Number(j.tax_applied.tax_value) > 0) {
        const t = j.tax_applied;
        notes.push(
          `GST recorded: taxable ${fmt(t.taxable)} · CGST ${fmt(t.cgst)} + SGST ${fmt(t.sgst)} = ${fmt(t.tax_value)}. ` +
          'Recorded against the bill as input credit — it is NOT in the item rate, so no recipe cost moved because of it.'
        );
      }
      const forcedZero = (j.tax_applied?.lines || []).filter((l: any) => l?.zero_rated_store_item);
      if (forcedZero.length > 0) {
        notes.push(
          `${forcedZero.length} line(s) were recorded at 0% GST: they are store/TGBCL materials, ` +
          'which are taxed through excise / cess / TCS on the store bill, never through GST.'
        );
      }
      // THE PARTIAL CASE. The PO stays open until every vendor's lines are in,
      // so say plainly who is still to come rather than letting "Received" imply
      // the whole order landed.
      const complete = j.po_complete !== false;
      if (!complete) {
        // Always spoken: a receiver who is told nothing will assume the PO is done.
        alert([
          `${j.vendor || 'Vendor'} received (${j.lines_processed} line(s), GRN ${j.grn_number}).`,
          `PO ${po?.po_number || ''} stays OPEN — still to deliver: ${(j.remaining_vendors || []).join(', ')}.`,
          ...notes,
        ].join('\n\n'));
      } else if (notes.length > 0) {
        // Unchanged: a clean receive stays silent, exactly as it always has.
        alert(`Received${isMultiVendor ? ` — ${j.vendor || ''} (this PO is now complete)` : ''}.\n\n` + notes.join('\n\n'));
      } else if (isMultiVendor) {
        alert(`${j.vendor || 'Vendor'} received — PO ${po?.po_number || ''} is now complete.`);
      }
      if (complete) { onReceived(); return; }
      // Still open: stay put and reload the ledger so the next vendor can be
      // received right away, with every field of this bill cleared.
      await load(null);
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-3 overflow-y-auto">
      {/* Capped shell (header + footer pinned, body scrolls): the charges card
          made this modal tall enough to push Confirm below the fold on phones —
          the same bug the create-PO modal already fixed once. */}
      {/* max-w-5xl (was 3xl): the four tax columns read left-to-right off the
          Line Total, and at 3xl they were permanently behind a sideways scroll.
          The table still sits in its own overflow-x-auto for narrow screens. */}
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-5xl my-4 shadow-xl flex flex-col overflow-hidden"
           style={{ maxHeight: 'calc(100vh - 1.5rem)' }}>
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
          <div>
            {/* The header named the PO but never the vendor, so a receiver had
                no on-screen confirmation of WHOSE goods they were booking into
                stock — and on a PO that spans vendors, that is a wrong-supplier
                purchase row, not a cosmetic gap. */}
            <h2 className="font-bold text-[#2D1B0E]">
              Receive PO {po?.po_number}
              {vendorLabel && <span className="font-normal text-[#6B5744]"> · {vendorLabel}</span>}
            </h2>
            {/* Says what the screen now actually does. The old sentence ("the
                rate is locked to the PO and only an admin can change it")
                described a lock that no longer exists — and a header that lies
                about who may change a price is worse than no header at all. */}
            <p className="text-xs text-[#8B7355] mt-0.5">
              Adjust the qty if you got more / less. The rate starts at the PO rate and can be corrected
              to what the vendor actually billed — any line that differs from the PO needs a reason, and the admin is
              notified with it. GST is worked out per line after discount and recorded on its own; it never enters the rate.
              Stock + recipe costs update on submit.
              {isMultiVendor && ' This PO spans several vendors — each is received separately, on their own bill.'}
            </p>
          </div>
          <button onClick={dismiss} className="text-[#8B7355]">✕</button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3">
          {/* ── WHOSE DELIVERY IS THIS ────────────────────────────────────────
              Only shown when the PO actually spans more than one vendor, so a
              plain single-vendor receive looks exactly as it always did. Each
              card is one vendor's stake: what they still owe, or the bill they
              already delivered against. */}
          {!loading && isMultiVendor && (
            <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] px-3 py-2.5 space-y-2">
              <div className="text-xs font-semibold text-[#2D1B0E]">
                Which vendor is delivering?
                <span className="ml-2 font-normal text-[10px] text-[#8B7355]">
                  {openStakes.length === 0
                    ? 'every vendor is in'
                    : `${openStakes.length} of ${stakes.length} still to deliver — the PO stays open until all are in`}
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {stakes.map(v => {
                  const active = v.key === vendorKey;
                  return (
                    <button key={v.key} type="button" disabled={v.done}
                            onClick={() => setVendorKey(v.key)}
                            className={`text-left px-2.5 py-2 rounded-lg border text-[11px] transition-colors ${
                              v.done ? 'border-[#E8D5C4] bg-white/50 opacity-70 cursor-default'
                              : active ? 'border-[#af4408] bg-white ring-1 ring-[#af4408]'
                              : 'border-[#D4B896] bg-white hover:border-[#af4408]'}`}>
                      <div className="font-semibold text-[#2D1B0E] flex items-center gap-1.5">
                        {v.done
                          ? <CheckCircle2 className="w-3 h-3 text-green-600 shrink-0" />
                          : <PackageCheck className={`w-3 h-3 shrink-0 ${active ? 'text-[#af4408]' : 'text-[#8B7355]'}`} />}
                        <span className="truncate">{v.vendor_name || '(no vendor on these lines)'}</span>
                      </div>
                      {v.done ? (
                        <div className="mt-0.5 text-[10px] text-[#6B5744]">
                          Received{v.grn_numbers.length > 0 ? ` · ${v.grn_numbers.join(', ')}` : ''}
                          {v.bills.length > 0 && (
                            <span> · bill {v.bills.map(b => b.bill_no || '(no number)').join(', ')}</span>
                          )}
                        </div>
                      ) : (
                        <div className="mt-0.5 text-[10px] text-[#6B5744]">
                          {v.line_ids.length} line(s) · {fmt(v.ordered_value)} ordered
                          {v.blocked_line_ids.length > 0 && (
                            <span className="text-amber-700"> · {v.blocked_line_ids.length} store-mapped (not receivable here)</span>
                          )}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
              {!stake && openStakes.length > 0 && (
                <div className="text-[10px] text-amber-800">
                  Pick a vendor. Their bill number, bill date, delivery charge and discount apply to their lines only —
                  never to another vendor&apos;s goods on this PO.
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            <label className="text-xs text-[#6B5744] flex flex-col gap-1">
              Received on
              <input type="date" value={receivedAt} onChange={e => setReceivedAt(e.target.value)}
                     className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
            </label>
            {/* The VENDOR'S invoice date, which is routinely earlier than the day
                the truck arrived — recorded on their bill row, never used as the
                date the money is booked on (that is "Received on"). */}
            <label className="text-xs text-[#6B5744] flex flex-col gap-1">
              Vendor bill date
              <input type="date" value={billDate} onChange={e => setBillDate(e.target.value)}
                     className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
            </label>
          </div>

          {loading ? <div className="text-center text-xs text-[#8B7355] py-4">Loading items…</div>
           : !stake ? (
            <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] px-3 py-6 text-center text-xs text-[#8B7355]">
              {openStakes.length === 0
                ? 'Every vendor on this PO has already delivered. Nothing left to receive.'
                : 'Choose the vendor who is delivering to see their lines.'}
            </div>
           ) : (
            <>
            {/* ── WHOSE DELIVERY IS THIS (always) ───────────────────────────
                Pinned directly above the lines and NOT gated on isMultiVendor:
                the single-vendor PO is the common case, and it named no vendor
                anywhere in this modal. Sticky, because the vendor is the one
                fact the receiver must not lose while scrolling down twenty
                lines — booking a bill against the wrong supplier writes that
                supplier onto every purchase row and into their ledger. */}
            <div className="sticky top-0 z-10 -mx-5 px-5 py-2 bg-[#FFF1E3] border-y border-[#E8D5C4] flex items-center gap-2 flex-wrap">
              <PackageCheck className="w-4 h-4 text-[#af4408] shrink-0" />
              <span className="text-xs text-[#8B7355]">Receiving from</span>
              <span className="text-sm font-bold text-[#2D1B0E]">{vendorLabel || '—'}</span>
              <span className="text-[10px] text-[#6B5744] ml-auto">
                {visibleItems.length} line{visibleItems.length === 1 ? '' : 's'} outstanding · {fmt(stake.ordered_value)} ordered
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-[#8B7355]">
                  <tr>
                    <th className="text-left py-1 px-2 font-medium">Item</th>
                    <th className="text-right py-1 px-2 font-medium">Ordered Qty</th>
                    <th className="text-right py-1 px-2 font-medium">Received Qty</th>
                    <th className="text-right py-1 px-2 font-medium">Ordered ₹</th>
                    <th className="text-right py-1 px-2 font-medium">Actual ₹</th>
                    <th className="text-right py-1 px-2 font-medium">Line Total</th>
                    {/* TAX, reading left to right off the goods figure the way
                        the vendor's bill does: value → less discount → taxable
                        → × GST% → tax → incl. tax. Same columns, same order and
                        same wording as the ad-hoc GRN bill modal on /grn. */}
                    <th className="text-right py-1 px-2 font-medium" title="Line Total minus this line's share of the bill discount — the value GST is charged on. Compensation cess is NOT charged on this: it is charged on the Line Total, before the discount.">Taxable</th>
                    <th className="text-right py-1 px-2 font-medium" title="GST % is charged on the Taxable value (after discount). Compensation cess % is a separate levy charged on the Line Total (before discount) — it is never part of CGST + SGST.">GST % · Cess %</th>
                    <th className="text-right py-1 px-2 font-medium" title="Charged on the taxable value, split into CGST + SGST. Recorded on the bill — never added into the rate, so recipe costs stay on the true goods price.">Tax (C+S)</th>
                    <th className="text-right py-1 px-2 font-medium" title="Taxable + tax — what this line adds to the vendor's bill">Incl. Tax</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Rows are driven by `deviations`, not `items`, so the hints,
                      the reason gate and the payload all read one computation.
                      A PO's qty + rate are in the PURCHASE unit (kg, BTL, CASE)
                      — NOT the recipe/stock unit (g, ml), which differs by
                      pack_size. `u` is that purchase unit and labels every
                      qty/rate cell so the receiver knows what they're confirming. */}
                  {deviations.map(({ it, ov, qtyDiff, priceDiff, qtyOff, rateOff, u, meta, included, deviates, label }) => {
                    const lineTotal = Number(ov.quantity) * Number(ov.unit_price);
                    // Recipe hints — display only. Both bases are printed on the
                    // SAME row so an ordered "10 kg" and a received "10 kg" can
                    // never be read against a sibling cell in grams.
                    const ordHint = recipeHint(it.quantity, meta);
                    const rcvHint = recipeHint(Number(ov.quantity) || 0, meta);
                    const reason = reasons[it.id] || '';
                    /* This line's tax, from the ONE compute. Absent for an
                       excluded line — it is not on the bill, so it has no
                       taxable value and its cells read "—" rather than a figure
                       nothing will book. */
                    const t = tax.byId.get(it.id);
                    // Only a line ON this bill can be off-PO — an excluded one
                    // is not being received at all, so it owes no explanation.
                    const needsReason = included && deviates && reason.trim().length < MIN_REASON;
                    return (
                      <Fragment key={it.id}>
                      <tr className={`border-t border-[#E8D5C4]/50 ${!included ? 'opacity-45' : deviates ? 'bg-amber-50/40' : ''}`}>
                        <td className="py-1.5 px-2">
                          {/* ON THIS BILL? Unticking leaves the line outstanding
                              for the vendor's next invoice — which is a different
                              record from receiving it at qty 0 (that books it as
                              received-and-short and it can never be topped up). */}
                          <label className="flex items-start gap-1.5 cursor-pointer">
                            <input type="checkbox" checked={included} className="mt-0.5 accent-[#af4408]"
                                   onChange={e => setExcluded(x => ({ ...x, [it.id]: !e.target.checked }))} />
                            <span>
                              <span className={`${included ? 'text-[#2D1B0E]' : 'text-[#8B7355] line-through'}`}>{it.material_name}</span>
                              <span className="block text-[10px] text-[#8B7355]">
                                {it.material_sku} · {u}
                                {!included && <span className="text-amber-700"> · not on this bill — stays outstanding</span>}
                              </span>
                            </span>
                          </label>
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono">
                          {it.quantity.toLocaleString('en-IN')}
                          {u && <span className="ml-1 text-[10px] text-[#8B7355]">{u}</span>}
                          {ordHint && <div className={HINT_CLS}>{ordHint}</div>}
                        </td>
                        <td className="py-1.5 px-2">
                          <div className="flex items-center gap-1 justify-end">
                            {/* min=0 — receiving cannot be negative. Negative
                                stock corrections belong on the GRN page's
                                "back-correction" workflow, not here. */}
                            <input type="number" step="any" min={0} value={ov.quantity} disabled={!included}
                                   onChange={e => {
                                     const v = parseFloat(e.target.value);
                                     setQty(it.id, Number.isFinite(v) ? Math.max(0, v) : 0);
                                   }}
                                   className={`w-full px-1.5 py-1 border rounded text-right disabled:bg-[#F5EFE8] ${qtyOff && included ? 'border-amber-400 bg-amber-50' : 'border-[#E8D5C4]'}`} />
                            {u && <span className="text-[10px] text-[#8B7355]">{u}</span>}
                          </div>
                          {/* The box is a PURCHASE-unit box (same basis the PO
                              and the receive route store), so this hint only
                              reads the typed number out in recipe units — the
                              value posted is never round-tripped through it. */}
                          {rcvHint && <div className={`${HINT_CLS} mt-0.5 text-right`}>{rcvHint}</div>}
                          {qtyOff && (
                            <div className={`text-[9px] mt-0.5 text-right ${qtyDiff > 0 ? 'text-blue-600' : 'text-amber-700'}`}>
                              {qtyDiff > 0 ? '+' : ''}{qfmt(qtyDiff)}{u ? ' ' + u : ''} vs ordered
                            </div>
                          )}
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono text-[10px] text-[#8B7355]">
                          ₹{it.unit_price.toFixed(2)}{u && <span>/{u}</span>}
                        </td>
                        {/* RATE — the vendor's actual billed rate, typed by
                            whoever is receiving. It seeds from the PO and is the
                            number that rewrites average_price, so the moment it
                            stops matching the PO the row says so out loud: what
                            the PO agreed, the delta, and that a reason is now
                            required and the admin will be told. That statement
                            IS the control that replaced the padlock — the gate
                            itself (deviations → reasons → server alert) is
                            unchanged and cannot be skipped. */}
                        <td className="py-1.5 px-2">
                          <div className="flex items-center gap-1 justify-end">
                            {/* Raw draft in, parsed number out — see rateDraft.
                                min=0: a negative rate is a credit note, not a
                                purchase. */}
                            <input type="number" step="any" min={0} disabled={!included || !canEditRate}
                                   value={rateDraft[it.id] ?? String(ov.unit_price)}
                                   onChange={e => {
                                     const raw = e.target.value;
                                     setRateDraft(m => ({ ...m, [it.id]: raw }));
                                     const v = parseFloat(raw);
                                     setPrice(it.id, Number.isFinite(v) ? Math.max(0, v) : 0);
                                   }}
                                   className={`w-full px-1.5 py-1 border rounded text-right disabled:bg-[#F5EFE8] ${rateOff && included ? 'border-amber-400 bg-amber-50' : 'border-[#E8D5C4]'}`} />
                            {u && <span className="text-[10px] text-[#8B7355]">/{u}</span>}
                          </div>
                          {rateOff && included && (
                            <>
                              <div className={`text-[9px] mt-0.5 text-right ${priceDiff > 0 ? 'text-red-600' : 'text-green-700'}`}>
                                PO ₹{it.unit_price.toFixed(2)}{u && `/${u}`}
                                {' · '}{priceDiff > 0 ? '+' : ''}₹{priceDiff.toFixed(2)}{u && `/${u}`}
                              </div>
                              <div className="text-[9px] text-right text-amber-800">reason required · admin notified</div>
                            </>
                          )}
                          {/* Restores the PO rate — a half-typed change must not
                              survive as a deviation nobody meant to make. The
                              draft is cleared with it, or the box would keep
                              showing the abandoned keystrokes. */}
                          {rateOff && included && (
                            <button type="button"
                                    onClick={() => {
                                      setPrice(it.id, it.unit_price);
                                      setRateDraft(m => { const n = { ...m }; delete n[it.id]; return n; });
                                    }}
                                    className="mt-0.5 block ml-auto text-[9px] text-[#8B7355] hover:text-[#af4408] underline">
                              Reset to PO rate
                            </button>
                          )}
                          {/* A line accepted at ₹0 is rejected by the receive
                              route (it would wipe average_price to 0). Anyone
                              receiving can now fix it in place, so this only
                              has to say what to do.
                              Gated on qty > 0 the same way the route is
                              (`effAcc > 0 && effPrice <= 0`): a line received at
                              0 never reaches updateMaterialPrice, so the server
                              accepts it and this must not claim otherwise. */}
                          {included && Number(ov.quantity) > 0 && Number(ov.unit_price) <= 0 && (
                            <div className="mt-0.5 text-[9px] text-red-600 text-right">
                              Rate is ₹0 — type the billed rate to receive this line.
                            </div>
                          )}
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono font-semibold">{fmt(lineTotal)}</td>
                        {/* ── TAX, per line ─────────────────────────────────
                            Read straight off the one compute; nothing here
                            re-derives a share or a rounding. */}
                        <td className="py-1.5 px-2 text-right font-mono text-[#6B5744]">
                          {t ? fmt(t.taxable) : '—'}
                          {t && t.discount_share > 0 && (
                            <div className={HINT_CLS}>− {fmt(t.discount_share)} discount</div>
                          )}
                        </td>
                        <td className="py-1.5 px-2 text-right">
                          {!included ? <span className="text-[#8B7355]">—</span>
                           : t?.zero_rated ? (
                            /* Not the receiver's to set: this material belongs
                               to a store location, where excise / cess / TCS are
                               charged on the store's own bill. A GST% — or a
                               compensation cess % — on it would be tax that was
                               never paid, so NEITHER control is offered and the
                               compute forces both to 0 regardless. */
                            <div className="text-[10px] text-blue-700 leading-tight text-right" title={t.zero_reason}>
                              GST 0% · Cess 0%
                              <span className="block text-[9px] text-[#8B7355]">store item — taxed on the TGBCL bill</span>
                            </div>
                           ) : (
                            <div className="space-y-1">
                              <select value={lineGst[it.id] ?? ''}
                                      onChange={e => setLineGst(m => ({ ...m, [it.id]: e.target.value }))}
                                      title="Blank follows the bill's GST rate. Change it only for a line the vendor billed at a different rate."
                                      className="w-full px-1 py-1 bg-white border border-[#E8D5C4] rounded text-right text-[11px]">
                                <option value="">Bill ({billGstRate}%)</option>
                                {GST_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                              </select>
                              {/* COMPENSATION CESS %, seeded from the Raw
                                  Material master and freely editable — the
                                  printed bill wins over the master, same as the
                                  GST rate above it.
                                  A FREE number input, not a <select>: cess has
                                  no fixed rate card (12 on aerated drinks, other
                                  rates on tobacco), it mirrors the master's own
                                  free 0-100 field, and a select would render a
                                  12.5 blank while the compute booked it.
                                  Blank means NO CESS on this line — there is no
                                  bill-level cess to follow, unlike GST. */}
                              <input type="number" step="0.01" min="0" max="100"
                                     value={lineCess[it.id] ?? ''}
                                     onChange={e => setLineCess(m => ({ ...m, [it.id]: e.target.value }))}
                                     placeholder="Cess %"
                                     title="GST Compensation Cess % for this line (e.g. 12 on aerated drinks). Seeded from the Raw Material master; retype it if the printed bill says otherwise. Charged on the GROSS line value BEFORE the bill discount — unlike GST, which is charged after it. A separate levy: it is never part of CGST + SGST, and it is recorded beside the rate, never inside it."
                                     className="w-full px-1 py-1 bg-white border border-[#E8D5C4] rounded text-right text-[11px]" />
                              {t && t.compensation_cess > 0 && (
                                <div className={`${HINT_CLS} font-mono`}>
                                  cess {fmt(t.compensation_cess)}
                                  <span className="block font-sans">on gross {fmt(t.gross)}, pre-discount</span>
                                </div>
                              )}
                            </div>
                           )}
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono text-[#6B5744]">
                          {t ? fmt(t.tax_value) : '—'}
                          {t && t.tax_value > 0 && (
                            <div className={HINT_CLS}>{fmt(t.cgst)} + {fmt(t.sgst)}</div>
                          )}
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono text-[#2D1B0E]">
                          {t ? fmt(t.incl_tax) : '—'}
                        </td>
                      </tr>
                      {/* REASON — appears the moment a line stops matching the
                          PO (short, excess, or a changed rate). Required: the
                          receive route rejects a deviating line without one, and
                          the admin alert quotes it. */}
                      {deviates && included && (
                        <tr className="bg-amber-50/40">
                          {/* colSpan matches the 10 columns above (6 goods + 4 tax). */}
                          <td colSpan={10} className="px-2 pb-2">
                            <div className="flex flex-col sm:flex-row sm:items-center gap-1.5">
                              <span className={`text-[10px] shrink-0 ${needsReason ? 'text-amber-800 font-semibold' : 'text-[#6B5744]'}`}>
                                <AlertTriangle className="w-3 h-3 inline mr-1 -mt-0.5" />
                                {label}{needsReason ? ' — reason required' : ''}
                              </span>
                              <input value={reason}
                                     onChange={e => setReasons(r => ({ ...r, [it.id]: e.target.value }))}
                                     placeholder="Why does this differ from the PO? e.g. vendor short-supplied; rate revised on bill #1234"
                                     className={`flex-1 min-w-0 px-2 py-1 border rounded text-[11px] bg-white ${needsReason ? 'border-amber-400' : 'border-[#E8D5C4]'}`} />
                            </div>
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  {/* Both rows carry all 10 columns, so the tax columns total
                      under their own headings and the row still reads left to
                      right: goods → taxable → cess → tax → incl. tax. (Cess
                      totals under the GST % · Cess % column, where its per-line
                      control is — never inside the Tax (C+S) cell beside it.) */}
                  <tr className="border-t border-[#E8D5C4] font-semibold">
                    <td className="py-2 px-2 text-right" colSpan={3}>Ordered total</td>
                    <td colSpan={2} className="py-2 px-2 text-right font-mono text-[#8B7355]">{fmt(orderedTotal)}</td>
                    <td></td>
                    <td colSpan={4}></td>
                  </tr>
                  <tr className="font-semibold">
                    <td className="py-2 px-2 text-right" colSpan={3}>Receive total</td>
                    <td colSpan={2} className="py-2 px-2 text-right font-mono">{fmt(total)}</td>
                    <td className={`py-2 px-2 text-right font-mono text-xs ${total !== orderedTotal ? (total > orderedTotal ? 'text-red-600' : 'text-amber-700') : 'text-[#8B7355]'}`}>
                      {total !== orderedTotal ? `${total > orderedTotal ? '+' : ''}${fmt(total - orderedTotal)}` : '—'}
                    </td>
                    <td className="py-2 px-2 text-right font-mono">{fmt(tax.taxableTotal)}</td>
                    {/* The cess total sits under its own column, NOT inside the
                        Tax (C+S) cell beside it: that cell is the GST figure a
                        return is filed on, and cess is a separate levy on a
                        different base — each line's gross value, before the discount. */}
                    <td className="py-2 px-2 text-right font-mono text-[#6B5744]">
                      {tax.cessTotal > 0 && (
                        <>
                          {fmt(tax.cessTotal)}
                          <div className={`${HINT_CLS} font-normal`}>comp. cess · on gross</div>
                        </>
                      )}
                    </td>
                    <td className="py-2 px-2 text-right font-mono">
                      {fmt(tax.taxTotal)}
                      {tax.taxTotal > 0 && (
                        <div className={`${HINT_CLS} font-normal`}>{fmt(tax.cgstTotal)} + {fmt(tax.sgstTotal)}</div>
                      )}
                    </td>
                    <td className="py-2 px-2 text-right font-mono text-[#af4408]">{fmt(tax.inclTaxTotal)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            </>
          )}

          {/* BILL CHARGES — what the vendor's bill carries beyond the goods.
              Discount REDUCES the cost of the stock (it is netted into the rate
              booked to purchases.unit_price, which is what average_price — and
              therefore every recipe cost — averages). Delivery is RECORDED only:
              it is stored against the bill and never enters item cost. */}
          {!loading && stake && (
            <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] px-3 py-2.5 space-y-2">
              <div className="text-xs font-semibold text-[#2D1B0E]">
                Bill charges (optional)
                {isMultiVendor && (
                  <span className="ml-2 font-normal text-[10px] text-[#8B7355]">
                    — {stake.vendor_name || '(no vendor)'}&apos;s bill only. Allocated across their {visibleItems.length} line(s);
                    no other vendor&apos;s goods on this PO are re-costed.
                  </span>
                )}
              </div>
              <ChargeRow label="Delivery Charges" hint="recorded on the bill — does not change item cost"
                         mode={deliveryMode} value={deliveryValue}
                         onMode={setDeliveryMode} onValue={setDeliveryValue}
                         placeholder={deliveryMode === 'pct' ? 'e.g. 2' : 'e.g. 500'}
                         resolved={alloc.delivery} tone="text-[#6B5744]" />
              <ChargeRow label="Discount" hint="reduces what the goods cost — updates stock value + recipe costs"
                         mode={discountMode} value={discountValue}
                         onMode={setDiscountMode} onValue={setDiscountValue}
                         placeholder={discountMode === 'pct' ? 'e.g. 5' : 'e.g. 250'}
                         resolved={alloc.discount_applied} tone="text-emerald-700" negative />
              {/* GST is NOT a bill-level charge like the two rows above — it is
                  a DEFAULT rate each line inherits, and the tax is worked out
                  per line AFTER that line's discount share. Set once here
                  because one vendor bill is normally one rate; a line can still
                  override it in its own GST % cell. The tax is recorded beside
                  the goods rate and never inside it, so input credit stays
                  reclaimable and item cost stays true. */}
              <div className="flex items-center gap-3 flex-wrap border-t border-[#E8D5C4] pt-2">
                <span className="text-xs font-medium text-[#6B5744] min-w-[120px]">
                  GST Rate
                  <span className="block text-[10px] font-normal text-[#8B7355]">every line follows this unless the line overrides it</span>
                </span>
                <select value={billGstRate} onChange={e => setBillGstRate(e.target.value)}
                        className="px-2 py-1 bg-white border border-[#D4B896] rounded text-xs text-[#2D1B0E]">
                  {GST_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                </select>
                <span className="text-xs font-semibold ml-auto text-[#6B5744]">
                  CGST {fmt(tax.cgstTotal)} + SGST {fmt(tax.sgstTotal)} = <span className="text-[#2D1B0E]">{fmt(tax.taxTotal)}</span>
                </span>
              </div>
              <p className="text-[10px] text-[#8B7355]">
                GST is charged on the value <strong>after</strong> discount, shown per line, and recorded separately —
                it is never added into the item rate, so recipe costs stay on the true goods price.
                Compensation cess (per line, seeded from the Raw Material master) is charged on the line&apos;s
                <strong> gross value, before the discount</strong> — a different base on purpose — and it is a
                separate levy, never part of CGST + SGST. It is recorded beside the rate the same way.
              </p>
              <div className="flex flex-col sm:flex-row gap-2">
                <input value={billNo} onChange={e => setBillNo(e.target.value)}
                       placeholder="Vendor bill no. (required)" required
                       className="sm:w-48 px-2 py-1 border border-[#E8D5C4] rounded text-[11px] bg-white" />
                {alloc.discount_applied > 0 && (
                  <input value={chargesNote} onChange={e => setChargesNote(e.target.value)}
                         placeholder="Why the discount? e.g. 5% scheme on bill #4471"
                         className={`flex-1 min-w-0 px-2 py-1 border rounded text-[11px] bg-white ${needsChargeNote ? 'border-amber-400' : 'border-[#E8D5C4]'}`} />
                )}
              </div>
              {/* RECONCILE AGAINST THE PAPER BILL IN THE RECEIVER'S HAND. Reads
                  in the same order the vendor's invoice does — goods, discount,
                  taxable, CGST, SGST, compensation cess, delivery, bill total —
                  so it can be checked line by line before Confirm. Shown
                  whenever there are charges OR any tax: a bill with 18% GST and
                  no discount still has to be reconciled, and so does one with
                  cess but no GST at all (cess is item-specific, so that is a
                  real bill — hence cessTotal in the gate, not just taxTotal). The one figure that is NOT on the paper
                  bill is called out on its own: what actually becomes the cost
                  of the stock, which excludes both tax and delivery. */}
              {(hasCharges || tax.taxTotal > 0 || tax.cessTotal > 0) && alloc.subtotal > 0 && (
                <div className="border-t border-[#E8D5C4] pt-1.5 text-[11px] font-mono space-y-0.5">
                  <div className="flex justify-between text-[#6B5744]"><span>Goods (accepted subtotal)</span><span>{fmt(alloc.subtotal)}</span></div>
                  <div className="flex justify-between text-emerald-700">
                    <span>− Discount</span><span>{alloc.discount_applied > 0 ? `− ${fmt(alloc.discount_applied)}` : fmt(0)}</span>
                  </div>
                  <div className="flex justify-between text-[#2D1B0E]">
                    <span>= Taxable</span><span>{fmt(tax.taxableTotal)}</span>
                  </div>
                  <div className="flex justify-between text-[#6B5744]"><span>+ CGST</span><span>{fmt(tax.cgstTotal)}</span></div>
                  <div className="flex justify-between text-[#6B5744]"><span>+ SGST</span><span>{fmt(tax.sgstTotal)}</span></div>
                  {/* ON ITS OWN LINE, AND ON ITS OWN BASE. Compensation cess is
                      not GST: it is never halved into CGST/SGST above, and it is
                      charged on each line's GROSS value BEFORE the discount, not
                      on the Taxable line. Stated in the label because the two bases
                      differ by design and the arithmetic otherwise looks wrong. */}
                  <div className="flex justify-between text-[#6B5744]">
                    {/* NOT "on {alloc.subtotal}": cess is item-specific, so only
                        the lines that carry a rate contribute. The base named
                        here is the per-line one, which is what each row shows. */}
                    <span>+ Comp. cess <span className="font-sans text-[9px] text-[#8B7355]">(each line&apos;s gross, before discount)</span></span>
                    <span>{fmt(tax.cessTotal)}</span>
                  </div>
                  <div className="flex justify-between text-[#8B7355]">
                    <span>+ Delivery (recorded only)</span><span>{fmt(alloc.delivery)}</span>
                  </div>
                  <div className="flex justify-between font-semibold text-[#af4408] border-t border-[#E8D5C4]/60 pt-0.5">
                    <span>Bill total</span><span>{fmt(tax.billTotal)}</span>
                  </div>
                  <div className="flex justify-between text-[#2D1B0E] border-t border-[#E8D5C4]/60 pt-0.5">
                    <span className="font-semibold">Cost basis booked to stock</span><span className="font-semibold">{fmt(alloc.net_subtotal)}</span>
                  </div>
                  <div className="text-[9px] text-[#8B7355] font-sans leading-tight">
                    Goods less discount — GST, compensation cess and delivery are on the bill but not in the cost
                    of the stock. GST is reclaimable input credit, not part of what the food costs; compensation
                    cess is a separate levy, recorded the same way and likewise kept out of item cost.
                  </div>
                </div>
              )}
              {alloc.discount_clamped && (
                <div className="text-[10px] text-amber-800">
                  The discount is larger than the bill — capped at {fmt(alloc.subtotal)}.
                </div>
              )}
              {chargeBlockers.length > 0 && (
                <ul className="text-[10px] text-red-700 space-y-0.5">
                  {chargeBlockers.map((b, i) => <li key={i}>• {b}</li>)}
                </ul>
              )}
              {zeroCost.length > 0 && (
                <div className="text-[10px] text-red-700">
                  A line booked at ₹0 would wipe that material&apos;s average price and every recipe that uses it
                  (floor {fmt(MIN_NET_RATE)}). Reduce the discount, or record it as a credit note instead.
                </div>
              )}
            </div>
          )}

          {/* Names every line still blocking the receive, so the receiver never
              has to hunt for which row the disabled button is waiting on. */}
          {missingReason.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">
                  {missingReason.length} line(s) differ from the PO and still need a reason (min {MIN_REASON} characters):
                </div>
                <ul className="mt-0.5 space-y-0.5">
                  {missingReason.map(d => (
                    <li key={d.it.id}>• <span className="font-medium">{d.it.material_name}</span> — {d.label}</li>
                  ))}
                </ul>
                <div className="mt-1 text-[10px]">The admin is alerted with the reason you give.</div>
              </div>
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
          <button onClick={dismiss} className="px-3 py-2 text-sm text-[#6B5744]">
            {didReceive ? 'Done' : 'Cancel'}
          </button>
          <button onClick={submit}
                  disabled={saving || loading || !stake || activeDeviations.length === 0
                            || missingReason.length > 0 || chargeBlockers.length > 0}
                  title={!stake ? 'Pick which vendor is delivering'
                       : activeDeviations.length === 0 ? 'Tick at least one line to put on this bill'
                       : missingReason.length > 0 ? missingList('Reason still needed on:\n')
                       : chargeBlockers.length > 0 ? chargeBlockers.join('\n') : undefined}
                  className="px-3 py-2 text-sm bg-green-600 hover:bg-green-700 text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <PackageCheck className="w-4 h-4" />}
            {/* Names the vendor on a mixed PO so nobody confirms the wrong truck. */}
            {isMultiVendor && stake ? `Receive ${stake.vendor_name || '(no vendor)'}` : 'Confirm Receive'}
          </button>
        </div>
      </div>
    </div>
  );
}

function RoleToggle({ role, onChange }: { role: 'admin' | 'manager'; onChange: (r: 'admin' | 'manager') => void }) {
  return (
    <div className="flex items-center gap-1 bg-[#FFF1E3] rounded-lg p-1 text-xs">
      <span className="text-[#8B7355] px-2">Role:</span>
      {(['manager', 'admin'] as const).map(r => (
        <button key={r} onClick={() => onChange(r)}
                className={`px-2.5 py-1 rounded-md font-medium transition-colors capitalize ${role === r ? 'bg-[#af4408] text-white' : 'text-[#6B5744] hover:bg-white'}`}>
          {r === 'admin' ? <ShieldCheck className="w-3 h-3 inline mr-1" /> : null}{r}
        </button>
      ))}
    </div>
  );
}

/* ============================================================ */
/* PO Detail row (expanded items table) + inline edit support    */
/* ============================================================ */
function PODetail({ po, editing, materials, onCancelEdit, onSaved }: {
  po: PO; editing: boolean; materials: Material[]; onCancelEdit: () => void; onSaved: () => void;
}) {
  const [items, setItems] = useState<POItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/purchase-orders?id=${po.id}`).then(r => r.json()).then(d => {
      setItems(d.purchase_order?.items || []); setLoading(false);
    });
  }, [po.id]);

  if (loading) {
    return <tr><td colSpan={8} className="py-3 px-3 text-xs text-[#8B7355] bg-[#FFF8F0]">Loading items…</td></tr>;
  }
  if (editing) {
    return <tr><td colSpan={8} className="py-3 px-3 bg-[#FFF8F0]">
      <EditPOItems poId={po.id} initialDate={po.date} initialDeliveryDate={po.delivery_date} initialVendor={po.vendor} initialNotes={po.notes}
                   initialItems={items} materials={materials} onCancel={onCancelEdit} onSaved={onSaved} />
    </td></tr>;
  }
  // Status-based column layout — once the PO is received we mirror the print
  // page and show Ordered + Received side-by-side so any variance is obvious
  // on screen too (until now it was print-only).
  const isReceived = po.status === 'received';
  // Per-vendor receiving leaves a PART-received PO at 'approved', so keying the
  // received columns on the status alone hid goods already booked into stock,
  // purchases and average_price. Mirror the print page: show them the moment any
  // line has a GRN row. (received_line_total is the API's "matched to a GRN"
  // marker; it is set even for a truthful ₹0 line, unlike a > 0 sum test.)
  const anyReceived = isReceived || items.some(it => (it as any).received_line_total != null);
  return (
    <tr><td colSpan={8} className="py-3 px-3 bg-[#FFF8F0]">
      <div className="flex items-start gap-6">
        <div className="text-xs text-[#6B5744] space-y-1">
          {/* The two dates that bracket the order, side by side: when we raised
              it, and when the vendor said it would land. An overdue promise is
              called out here too — the detail panel is where a buyer chasing a
              late delivery actually looks. */}
          <div><span className="font-semibold">PO Date:</span> {dateLabel(po.date)}</div>
          <div>
            <span className="font-semibold">Expected Delivery:</span>{' '}
            {po.delivery_date ? (
              <span className={isDeliveryOverdue(po.delivery_date, po.status) ? 'text-red-700 font-semibold' : ''}>
                {dateLabel(po.delivery_date)}
                {isDeliveryOverdue(po.delivery_date, po.status) && ' — overdue'}
              </span>
            ) : <span className="text-[#8B7355]">—</span>}
          </div>
          {po.notes && <div><span className="font-semibold">Notes:</span> {po.notes}</div>}
          {po.submitted_at && <div><span className="font-semibold">Submitted:</span> {dateLabel(po.submitted_at)}</div>}
          {po.approved_at  && <div><span className="font-semibold">Approved:</span>  {dateLabel(po.approved_at)} by {po.approved_by}</div>}
          {po.received_at  && <div><span className="font-semibold">Received:</span>  {dateLabel(po.received_at)}</div>}
          {po.rejected_reason && <div className="text-red-600"><span className="font-semibold">Rejected:</span> {po.rejected_reason}</div>}
        </div>
        <div className="flex-1 min-w-0 overflow-x-auto">
        <table className="text-xs w-full min-w-[640px]">
          <thead className="text-[#8B7355]">
            <tr>
              <th className="text-left  py-1 px-2 font-medium">SKU</th>
              <th className="text-left  py-1 px-2 font-medium">Material</th>
              <th className="text-left  py-1 px-2 font-medium">Vendor</th>
              <th className="text-right py-1 px-2 font-medium">{anyReceived ? 'Ordered Qty' : 'Qty'}</th>
              {/* Spelled out, same as the liquor Movement report's "Unit
                  (recipe)": every qty in this table is in the PURCHASE unit. */}
              <th className="text-left  py-1 px-2 font-medium">Unit (purchase)</th>
              <th className="text-right py-1 px-2 font-medium">{anyReceived ? 'Rate (Ord)' : 'Unit ₹'}</th>
              <th className="text-right py-1 px-2 font-medium">{anyReceived ? 'Ordered ₹' : 'Total ₹'}</th>
              {anyReceived && <>
                <th className="text-right py-1 px-2 font-medium bg-emerald-50">Received Qty</th>
                <th className="text-right py-1 px-2 font-medium bg-emerald-50">Rate (Act)</th>
                <th className="text-right py-1 px-2 font-medium bg-emerald-50">Received ₹</th>
                <th className="text-right py-1 px-2 font-medium bg-amber-50">Variance</th>
              </>}
            </tr>
          </thead>
          <tbody>
            {items.map(it => {
              // received_* fields come from /api/purchase-orders when grn_id is set
              // (server folds the linked GRN items into the response). See the
              // PO API GET handler for the join logic.
              const recQty   = (it as any).quantity_accepted ?? (it as any).quantity_received;
              const recPrice = (it as any).received_unit_price ?? it.unit_price;
              const recTotal = (it as any).received_line_total ?? (recQty != null ? Number(recQty) * Number(recPrice) : null);
              // On a part-received PO the un-delivered lines carry no GRN row, and
              // recPrice falls back to the ORDERED rate — printing that would make
              // an outstanding line look delivered at its ordered price. lineIn is
              // the per-line "this one actually arrived" test.
              const lineIn = (it as any).received_line_total != null;
              const qtyDiff   = lineIn && recQty != null ? Number(recQty) - Number(it.quantity) : 0;
              const priceDiff = lineIn && recPrice != null ? Number(recPrice) - Number(it.unit_price) : 0;
              const valDiff   = lineIn && recTotal != null ? Number(recTotal) - Number(it.total_price) : 0;
              const rejected  = Number((it as any).quantity_rejected) || 0;
              // A PO line is expressed in the PURCHASE unit (kg/BTL/CASE) at
              // ₹/purchase-unit — never the recipe unit (g/ml), which differs by
              // pack_size. GET /api/purchase-orders?id= returns
              // material_purchase_unit for exactly this label (same derivation as
              // the receive modal), so "10 kg @ ₹900/kg" can't read as ₹900/g.
              const u = (it as any).material_purchase_unit || it.material_unit || '';
              // ONE pack resolution for the whole row — ordered, received and
              // rejected are all purchase-basis GRN/PO numbers, so they share it.
              const meta = packMetaOf(it);
              const ordHint = recipeHint(it.quantity, meta);
              const rcvHint = recQty != null ? recipeHint(Number(recQty), meta) : null;
              const rejHint = recipeHint(rejected, meta);
              return (
                <tr key={it.id} className="border-t border-[#E8D5C4]/50">
                  <td className="py-1 px-2 font-mono text-[10px] text-[#8B7355]">{it.material_sku || '·'}</td>
                  <td className="py-1 px-2">
                    {it.material_name}
                    {anyReceived && rejected > 0 && (
                      <div className="text-[10px] text-red-700 mt-0.5">
                        {/* quantity_rejected is a GRN qty = PURCHASE units, and
                            it was printing raw (0.30000000000000004). */}
                        Rejected: {qfmt(rejected)} {u}
                        {(it as any).rejection_reason && <span className="capitalize"> ({String((it as any).rejection_reason).replace(/_/g, ' ')})</span>}
                        {rejHint && <span className={`${HINT_CLS} ml-1`}>{rejHint}</span>}
                      </div>
                    )}
                  </td>
                  <td className="py-1 px-2 text-[#6B5744]">{(it as any).vendor || <span className="text-[#8B7355] italic">—</span>}</td>
                  <td className="py-1 px-2 text-right font-mono">
                    {it.quantity.toLocaleString('en-IN')}
                    {ordHint && <div className={HINT_CLS}>{ordHint}</div>}
                  </td>
                  <td className="py-1 px-2 text-[#6B5744]">{u}</td>
                  <td className="py-1 px-2 text-right font-mono">{fmt(it.unit_price)}</td>
                  <td className="py-1 px-2 text-right font-mono font-semibold">{fmt(it.total_price)}</td>
                  {anyReceived && <>
                    <td className={`py-1 px-2 text-right font-mono ${qtyDiff !== 0 ? (qtyDiff > 0 ? 'bg-amber-50 text-amber-900 font-semibold' : 'bg-red-50 text-red-700 font-semibold') : 'bg-emerald-50/30'}`}>
                      {lineIn && recQty != null ? Number(recQty).toLocaleString('en-IN') : '—'}
                      {lineIn && rcvHint && <div className={HINT_CLS}>{rcvHint}</div>}
                    </td>
                    <td className={`py-1 px-2 text-right font-mono ${priceDiff !== 0 ? (priceDiff > 0 ? 'bg-red-50 text-red-700 font-semibold' : 'bg-emerald-50 text-emerald-800 font-semibold') : 'bg-emerald-50/30'}`}>
                      {lineIn && recPrice != null ? fmt(Number(recPrice)) : '—'}
                    </td>
                    <td className="py-1 px-2 text-right font-mono bg-emerald-50/30">
                      {lineIn && recTotal != null ? fmt(Number(recTotal)) : '—'}
                    </td>
                    <td className={`py-1 px-2 text-right font-mono text-[10px] ${valDiff === 0 ? 'text-[#8B7355]' : valDiff > 0 ? 'text-red-700' : 'text-amber-700'}`}>
                      {/* qfmt, not the raw float: 2.4 − 2.5 prints as
                          −0.09999999999999964 straight out of the subtraction.
                          Purchase basis on both sides, so the delta is too. */}
                      {qtyDiff !== 0 && (
                        <div title={`Qty ${qtyDiff > 0 ? '+' : ''}${qfmt(qtyDiff)} ${u}`}>
                          {qtyDiff > 0 ? '+' : ''}{qfmt(qtyDiff)} {u}
                        </div>
                      )}
                      {valDiff !== 0 && (
                        <div>{valDiff > 0 ? '+' : ''}{fmt(valDiff)}</div>
                      )}
                      {qtyDiff === 0 && valDiff === 0 && '—'}
                    </td>
                  </>}
                </tr>
              );
            })}
          </tbody>
          {anyReceived && (
            <tfoot>
              <tr className="border-t border-[#E8D5C4] font-semibold bg-white/60">
                {/* "so far" while other vendors still owe goods — the received
                    column sums only the lines with a GRN row. */}
                <td colSpan={6} className="py-1.5 px-2 text-right">Totals{isReceived ? '' : ' (so far)'}</td>
                <td className="py-1.5 px-2 text-right font-mono">
                  {fmt(items.reduce((s, it) => s + Number(it.total_price || 0), 0))}
                </td>
                <td colSpan={2}></td>
                <td className="py-1.5 px-2 text-right font-mono bg-emerald-50">
                  {fmt(items.reduce((s, it) => s + Number((it as any).received_line_total || 0), 0))}
                </td>
                <td className="py-1.5 px-2 text-right font-mono text-[10px] bg-amber-50">
                  {(() => {
                    const ord = items.reduce((s, it) => s + Number(it.total_price || 0), 0);
                    const rec = items.reduce((s, it) => s + Number((it as any).received_line_total || 0), 0);
                    const d = rec - ord;
                    return d === 0 ? '—' : (d > 0 ? '+' : '') + fmt(d);
                  })()}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
        </div>
      </div>
    </td></tr>
  );
}

/* ============================================================ */
/* Create new PO modal                                            */
/* ============================================================ */
interface POLine {
  uid: string;             // stable row identity — see newLineUid()
  material_id: string;
  quantity: number;
  unit_price: number;
  vendor: string;          // master vendor name, or a purchase-history name the
                           // master no longer resolves (the __legacy__ option)
  vendor_id: string;       // optional FK to vendors master
}

/* Rows were keyed by array index, so deleting a line handed the removed row's
 * per-line child state (ContractFlag's fetched contract, EligibleVendorChips'
 * list) to the row that shifted into its slot — and "remove the line to change
 * the item" makes deletion routine. A monotonic counter, not crypto.randomUUID,
 * which is undefined on plain-http LAN origins. */
let poLineSeq = 0;
const newLineUid = () => `poline-${++poLineSeq}`;

/**
 * Eligible-vendor quick-pick chips for a PO line.
 * Loads vendors we've actually purchased this material from (purchases table).
 * Click a chip → fills vendor name + vendor_id + (optionally) last unit price.
 */
interface EligibleVendor {
  vendor: string; vendor_id: string | null;
  payment_terms: string | null; lead_time_days: number | null;
  purchase_count: number; last_date: string | null;
  last_price: number | null; avg_price: number | null; total_qty: number;
  contract_id: string | null;
  contract_price: number | null;
  contract_valid_to: string | null;
}
/**
 * Off-contract flag for a PO line. Looks up the active contract for the
 * (vendor_id, material_id) pair and compares against the buyer-entered price.
 * - On contract → small green "📄 Contract ₹X" chip
 * - Diverges    → red flag with delta and a one-click "match contract" button
 */
function ContractFlag({ materialId, vendorId, unitPrice, onMatch }: {
  materialId: string; vendorId: string; unitPrice: number;
  onMatch: (price: number) => void;
}) {
  const [contract, setContract] = useState<{ unit_price: number; valid_to: string | null } | null>(null);
  useEffect(() => {
    // Clear FIRST, always: the previous (material, vendor) pair's contract used
    // to stay on screen — and stay wired to the one-click "match" button — when
    // the pair changed or the refetch failed (the .catch below is silent).
    setContract(null);
    if (!materialId || !vendorId) return;
    const ctrl = new AbortController();
    fetch(`/api/vendor-contracts?material_id=${materialId}&vendor_id=${vendorId}&active=1`, { signal: ctrl.signal })
      .then(r => r.json())
      .then(d => {
        const c = (d.contracts || [])[0];
        // A 0/blank contract rate is "no price agreed", not an authoritative ₹0
        // — otherwise "match" would wipe the line rate to zero.
        setContract(c && Number(c.unit_price) > 0 ? { unit_price: Number(c.unit_price), valid_to: c.valid_to } : null);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [materialId, vendorId]);
  if (!contract) return null;
  const diff = unitPrice - contract.unit_price;
  const pct = contract.unit_price > 0 ? (diff / contract.unit_price) * 100 : 0;
  const onPrice = Math.abs(diff) < 0.01;
  if (onPrice) {
    return (
      <div className="text-[10px] text-emerald-700 mt-0.5 font-medium">
        📄 On contract ₹{contract.unit_price.toFixed(2)}
        {contract.valid_to && <span className="text-[#8B7355] ml-1">(until {contract.valid_to})</span>}
      </div>
    );
  }
  return (
    <div className="text-[10px] text-red-700 mt-0.5 font-medium flex items-center gap-1 flex-wrap">
      ⚠ Off-contract: ₹{contract.unit_price.toFixed(2)} ({diff > 0 ? '+' : ''}{pct.toFixed(1)}%)
      <button type="button" onClick={() => onMatch(contract.unit_price)}
              className="underline hover:text-red-900">match</button>
    </div>
  );
}

function EligibleVendorChips({ materialId, currentVendor, onPick, isMappedVendor, onBlockedPick }: {
  materialId: string;
  currentVendor: string;
  onPick: (v: EligibleVendor) => void;
  /** STRICT MAPPING: these chips come from purchase HISTORY, which can name a
   *  vendor nobody has since mapped to this item. When supplied, an unmapped
   *  chip is shown greyed and cannot be clicked into the line — otherwise the
   *  quickest control on the row would be the one that files a pair the save
   *  refuses. History stays VISIBLE (it is real, and it tells the buyer who to
   *  map) — it is just not selectable. */
  isMappedVendor?: (v: EligibleVendor) => boolean;
  onBlockedPick?: (v: EligibleVendor) => void;
}) {
  const [list, setList] = useState<EligibleVendor[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!materialId) { setList([]); return; }
    setLoading(true);
    fetch(`/api/vendors/for-material?material_id=${materialId}`)
      .then(r => r.json())
      .then(d => setList(d.vendors || []))
      .catch(() => setList([]))
      .finally(() => setLoading(false));
  }, [materialId]);

  if (!materialId) return null;
  if (loading)     return <div className="text-[10px] text-[#8B7355] mt-1">Loading vendors…</div>;
  if (list.length === 0) {
    return <div className="text-[10px] text-[#8B7355] italic mt-1">No prior purchases — pick a vendor from the dropdown above.</div>;
  }
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      <span className="text-[10px] text-[#8B7355] mr-1 self-center">Past suppliers:</span>
      {list.slice(0, 6).map(v => {
        const active = currentVendor.toLowerCase().trim() === v.vendor.toLowerCase().trim();
        // > 0, not != null: a ₹0 contract row means no rate was agreed, so it must
        // not show as a contract chip nor be picked as the line rate.
        const hasContract = Number(v.contract_price) > 0;
        const blocked = !!isMappedVendor && !isMappedVendor(v);
        return (
          <button
            key={v.vendor}
            type="button"
            onClick={() => (blocked ? onBlockedPick?.(v) : onPick(v))}
            title={[
              blocked ? 'NOT MAPPED to this item — map the pair on Vendor Items before ordering' : null,
              `${v.purchase_count} purchase${v.purchase_count > 1 ? 's' : ''}`,
              v.last_date ? `last ${v.last_date}` : null,
              v.last_price != null ? `last ₹${v.last_price.toFixed(2)}` : null,
              v.avg_price  != null ? `avg ₹${v.avg_price.toFixed(2)}`  : null,
              hasContract ? `CONTRACT ₹${Number(v.contract_price).toFixed(2)}${v.contract_valid_to ? ` until ${v.contract_valid_to}` : ' (open)'}` : null,
              v.payment_terms || null,
              v.lead_time_days ? `${v.lead_time_days}d lead` : null,
            ].filter(Boolean).join(' · ')}
            className={`text-[10px] px-1.5 py-0.5 rounded border transition ${
              blocked
                ? 'bg-[#F7F1E9] text-[#A08B76] border-dashed border-[#D4B896] cursor-not-allowed'
                : active
                  ? 'bg-[#af4408] text-white border-[#af4408]'
                  : hasContract
                    ? 'bg-emerald-50 text-emerald-900 border-emerald-300 hover:border-emerald-500'
                    : 'bg-white text-[#2D1B0E] border-[#E8D5C4] hover:border-[#af4408] hover:bg-[#FFF1E3]'
            }`}
          >
            {blocked && <span className="mr-0.5">🔒</span>}
            {v.vendor}
            {hasContract ? (
              <span className={`ml-1 font-mono font-semibold ${active ? 'text-white' : 'text-emerald-700'}`}>
                {/* 2 dp, like every other ₹ here: at 0 dp this chip showed
                    "₹236" while the ContractFlag directly below it showed the
                    same contract as ₹235.50. */}
                📄₹{Number(v.contract_price).toFixed(2)}
              </span>
            ) : v.last_price != null && (
              <span className={`ml-1 font-mono ${active ? 'text-white/80' : 'text-[#8B7355]'}`}>
                ₹{v.last_price.toFixed(2)}
              </span>
            )}
            <span className={`ml-1 ${active ? 'text-white/70' : 'text-[#8B7355]'}`}>×{v.purchase_count}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ============================================================ */
/* STRICT VENDOR ↔ ITEM MAPPING (owner rule)                      */
/*                                                                */
/* "Vendor mapping should be done in Vendor Items first … 1 vendor */
/* may have limited items but an item can have different vendors." */
/*                                                                */
/*   pick the VENDOR first → only that vendor's mapped items       */
/*   pick the ITEM   first → only vendors mapped to that item      */
/*                                                                */
/* BOTH directions come out of ONE payload (/api/vendor-materials  */
/* ?index=1, built by @/lib/vendor-mapping), which is the SAME     */
/* `vendor_materials` rows the server checks in vendorMappingError */
/* before it will write a line. A dropdown here can therefore      */
/* never offer a pair the save refuses — the filter is the         */
/* convenience, the server is the rule.                            */
/* ============================================================ */
const VENDOR_ITEMS_HREF = '/vendors/materials';
const vendorItemsHref = (vendorId?: string) =>
  vendorId ? `${VENDOR_ITEMS_HREF}?vendor=${encodeURIComponent(vendorId)}` : VENDOR_ITEMS_HREF;

interface VendorItemIndexPayload {
  by_vendor: Record<string, string[]>;
  vendor_names: Record<string, string>;
  vendors_no_items?: Array<{ id: string; name: string }>;
  pair_count?: number;
}
const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();
const EMPTY_ID_LIST: readonly string[] = [];

/** Loads the whole map once and answers both directions off it.
 *  FAILS CLOSED: until the map has actually loaded, `ready` is false and the
 *  callers show "loading" / the error instead of an unfiltered list — offering
 *  every item and then having the save rejected is the exact failure this
 *  screen is meant to remove. */
function useVendorItemIndex() {
  const [idx, setIdx] = useState<VendorItemIndexPayload | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce(n => n + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch('/api/vendor-materials?index=1')
      .then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        return r.json();
      })
      .then(d => { if (!alive) return; setIdx(d); setError(''); })
      .catch(e => {
        if (!alive) return;
        setIdx(null);
        setError(e?.message || 'Could not load the vendor → item mapping.');
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [nonce]);

  const byVendor = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const [vid, mids] of Object.entries(idx?.by_vendor || {})) m.set(vid, new Set(mids));
    return m;
  }, [idx]);
  const byMaterial = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const [vid, mids] of Object.entries(idx?.by_vendor || {})) {
      for (const mid of mids) {
        const list = m.get(mid);
        if (list) list.push(vid); else m.set(mid, [vid]);
      }
    }
    return m;
  }, [idx]);

  return {
    ready: !!idx && !loading,
    loading, error, reload,
    /** Item ids this vendor is mapped to supply. */
    itemsOf: (vendorId: string): ReadonlySet<string> => byVendor.get(vendorId) || EMPTY_ID_SET,
    /** Vendor ids mapped to supply this item — an item can have many. */
    vendorsOf: (materialId: string): readonly string[] => byMaterial.get(materialId) || EMPTY_ID_LIST,
    itemCount: (vendorId: string) => byVendor.get(vendorId)?.size || 0,
    isMapped: (vendorId: string, materialId: string) =>
      !!vendorId && !!materialId && !!byVendor.get(vendorId)?.has(materialId),
  };
}
type VendorItemIndex = ReturnType<typeof useVendorItemIndex>;

/** The client's copy of the server rule, so the buyer is told BEFORE the round
 *  trip. Deliberately worded like @/lib/vendor-mapping's messages; the server
 *  still has the last word and its text is what gets shown on a 400. */
function mappingProblem(
  lineNo: number,
  vm: VendorItemIndex,
  vendorId: string,
  vendorName: string,
  materialId: string,
  materialLabel: string,
): string | null {
  if (!materialId || (!vendorId && !vendorName)) return null;   // other rules own these
  if (!vm.ready) return `Line ${lineNo}: the vendor → item mapping has not loaded, so this line cannot be checked. Reload the page.`;
  if (!vendorId) {
    return `Line ${lineNo}: "${vendorName}" is not in the Vendor master, so its item list cannot be checked. Pick the vendor from the dropdown.`;
  }
  if (vm.itemCount(vendorId) === 0) {
    return `Line ${lineNo}: ${vendorName} has no items mapped yet, so nothing can be ordered from them. Add their item list on Vendor Items, then save again.`;
  }
  if (!vm.isMapped(vendorId, materialId)) {
    return `Line ${lineNo}: ${vendorName} is not mapped to supply "${materialLabel}". Pick a vendor that supplies it, or map the item to ${vendorName} on Vendor Items.`;
  }
  return null;
}

/** Shown wherever a chosen vendor has no item list at all. THE EMPTY-MAP CASE:
 *  strict blocks the line, so the way out has to be one click away — a buyer
 *  standing at a delivery cannot debug a dropdown. */
function NoItemsForVendor({ vendorId, vendorName, compact }: {
  vendorId: string; vendorName: string; compact?: boolean;
}) {
  return (
    <div className={`rounded-lg border border-red-300 bg-red-50 text-red-800 ${compact ? 'px-2 py-1.5 text-[10px]' : 'px-3 py-2 text-[11px]'}`}>
      <div className="flex items-start gap-1.5">
        <AlertTriangle className={`${compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} mt-0.5 shrink-0`} />
        <div className="flex-1">
          <strong>{vendorName}</strong> has no items mapped yet, so nothing can be ordered from them.
          {' '}Set up their item list first — mapping is done on Vendor Items.
          <div className="mt-1">
            <a href={vendorItemsHref(vendorId)} target="_blank" rel="noopener noreferrer"
               className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#af4408] text-white hover:bg-[#8a3506] font-medium">
              Open Vendor Items for {vendorName} →
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function CreatePOModal({ materials, onClose, onCreated }: {
  materials: Material[]; onClose: () => void; onCreated: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  /* The vendor's promised date. Starts BLANK, never seeded from `today`: an
     unasked-for default would be recorded as a promise nobody made, and the
     whole point of the column is that a missing promise stays missing. */
  const [deliveryDate, setDeliveryDate] = useState('');
  const [vendors, setVendors] = useState<Array<{ id: string; name: string; payment_terms?: string; lead_time_days?: number }>>([]);
  const [notes, setNotes] = useState('');
  // Lazy initializer — newLineUid() must be called once, not on every render.
  const [items, setItems] = useState<POLine[]>(() => [
    { uid: newLineUid(), material_id: '', quantity: 1, unit_price: 0, vendor: '', vendor_id: '' },
  ]);
  const [saving, setSaving] = useState(false);
  // STRICT MAPPING. The header vendor is a convenience that seeds every line;
  // the rule is enforced per LINE, in both directions, off `vm` below.
  // `showAllMaterials` no longer bypasses anything — it reveals the items that
  // are NOT mapped to the line's vendor, greyed, each with a one-click "+ map"
  // so a buyer who is mid-order can declare the pair and carry on. Picking one
  // without mapping it is not possible: the save would be refused anyway.
  const [primaryVendorId, setPrimaryVendorId] = useState<string>('');
  const [primaryVendorName, setPrimaryVendorName] = useState<string>('');
  const [showAllMaterials, setShowAllMaterials] = useState(false);
  const [vendorLoadError, setVendorLoadError] = useState('');
  const [mapBusy, setMapBusy] = useState(false);
  const vm = useVendorItemIndex();
  /* LIVE in-hand stock, ONE batched call for the whole catalogue, made once when
     this modal mounts and held for its life (CONTRACT §4). Not per material, not
     per department, and never refreshed under the buyer mid-order. */
  const stock = useStockOnHand(true);

  // This list feeds BOTH the header dropdown and every line dropdown, and a line
  // vendor is required to save. A silently failed fetch would therefore leave the
  // form unsubmittable with no explanation. Surface it instead.
  useEffect(() => {
    fetch('/api/vendors')
      .then(r => r.json())
      .then(d => {
        const list = (d.vendors || []).filter((v: any) => v.is_active);
        setVendors(list);
        setVendorLoadError(list.length === 0 ? 'No active vendors found — add one under Vendors first.' : '');
      })
      .catch(() => setVendorLoadError('Could not load the vendor list — reload the page to try again.'));
  }, []);

  // Header vendor's display name. The mapping itself no longer needs a fetch of
  // its own — `vm` already holds every pair (see useVendorItemIndex).
  useEffect(() => {
    const v = vendors.find(x => x.id === primaryVendorId);
    setPrimaryVendorName(v?.name || '');
  }, [primaryVendorId, vendors]);

  const headerItemCount = primaryVendorId ? vm.itemCount(primaryVendorId) : 0;

  /** The two lists a line's item picker gets, resolved for the vendor that line
   *  will actually be saved against (its own vendor, else the header vendor).
   *  ONE function, so the "mapped" and "not mapped" halves can never overlap or
   *  leave an item out. */
  const pickListsFor = useCallback((lineVendorId: string) => {
    if (!vm.ready) return { mapped: [] as Material[], unmapped: [] as Material[] };
    if (lineVendorId) {
      const ids = vm.itemsOf(lineVendorId);
      return {
        mapped:   materials.filter(m => ids.has(m.id)),
        unmapped: materials.filter(m => !ids.has(m.id)),
      };
    }
    // No vendor chosen yet — ITEM-FIRST mode. Only items that at least one
    // vendor is mapped to supply can be ordered; the rest would be a dead end
    // (their vendor dropdown would come back empty), so they are shown in the
    // greyed half with the reason instead of silently disappearing.
    return {
      mapped:   materials.filter(m => vm.vendorsOf(m.id).length > 0),
      unmapped: materials.filter(m => vm.vendorsOf(m.id).length === 0),
    };
  }, [vm, materials]);

  /** Declare a (vendor, item) pair from here, then use it. The way out of the
   *  strict rule that does not involve leaving a half-typed PO: it writes the
   *  same `vendor_materials` row the Vendor Items screen writes, under the
   *  buyer's own email, so it shows up there as human-added, not as seed. */
  const mapAndUse = useCallback(async (vendorId: string, vendorName: string, mat: Material): Promise<boolean> => {
    if (!vendorId) return false;
    if (!window.confirm(
      `Map "${mat.name}" to ${vendorName}?\n\n` +
      `This says "${vendorName} supplies this item" and is saved on Vendor Items ` +
      `(it is a mapping only — no price, no contract). It applies to every future PO.`
    )) return false;
    setMapBusy(true);
    try {
      const r = await api('/api/vendor-materials', {
        method: 'POST',
        body: { vendor_id: vendorId, material_id: mat.id },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { alert(j.error || `Could not map the item (HTTP ${r.status}).`); return false; }
      vm.reload();
      return true;
    } finally { setMapBusy(false); }
  }, [vm]);

  const addLine = () => setItems(prev => [...prev, { uid: newLineUid(), material_id: '', quantity: 1, unit_price: 0, vendor: '', vendor_id: '' }]);
  /* material_id → the 1-based line it already sits on. Feeds the picker so a
     material that is already on this PO can't be added twice (one material =
     one line: a duplicate double-orders and, on receive, bumps stock twice). */
  const takenIds = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((l, idx) => { if (l.material_id && !m.has(l.material_id)) m.set(l.material_id, idx + 1); });
    return m;
  }, [items]);
  const [flashLine, setFlashLine] = useState<number | null>(null);
  const [dupNote, setDupNote] = useState<string | null>(null);
  // Scoped to THIS composer's item list: a document-wide [data-po-qty=N] lookup
  // focused the inline PO editor's row when both were mounted.
  const linesRef = useRef<HTMLDivElement | null>(null);
  /* Send the user to the line that already holds the item instead of silently
     doing nothing: focus its qty box, flash the row, and say where it went. */
  const goToTakenLine = (lineNo: number) => {
    const existing = items[lineNo - 1];
    const mat = materials.find(mm => mm.id === existing?.material_id);
    setDupNote(`${mat?.name || 'That item'} is already on line ${lineNo} — add the extra quantity there.`);
    setFlashLine(lineNo);
    setTimeout(() => setFlashLine(null), 1400);
    setTimeout(() => {
      const el = (linesRef.current || document).querySelector<HTMLInputElement>(`[data-po-qty="${lineNo}"]`);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el?.focus(); el?.select();
    }, 0);
  };

  const removeLine = (i: number) => setItems(prev => prev.filter((_, j) => j !== i));
  const updateLine = (i: number, patch: Partial<POLine>) =>
    setItems(prev => prev.map((it, j) => j === i ? { ...it, ...patch } : it));

  // POLine.quantity and POLine.unit_price are the two
  // composer inputs rendered a few hundred lines below, labelled `poUnitOf(mat)`
  // and `/ {poUnitOf(mat)}` (= purchase_unit, falling back to the recipe unit).
  // They POST verbatim into purchase_order_items, whose canon is PURCHASE units
  // at Rs/purchase-unit — so this draft total is the same product the server
  // stores as total_price. The recipeHint() beside the qty box is display-only
  // and never feeds this sum.
  // rate-basis: purchase (composer PURCHASE units x Rs/purchase-unit)
  const total = items.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.unit_price) || 0), 0);

  // Header derives "Vendor(s) used" from line items so user has a quick visual summary
  const vendorSummary = (() => {
    const set = new Set(items.map(i => i.vendor.trim()).filter(Boolean));
    if (set.size === 0) return null;
    if (set.size === 1) return [...set][0];
    return `Mixed (${set.size} vendors)`;
  })();

  const submit = async () => {
    // Validate PER ROW instead of silently filtering: a blank qty/rate box looks
    // unfinished, not invalid, so a dropped line used to vanish without a word
    // even though the footer Total (which sums EVERY row, material chosen or
    // not) had already counted it. The trash button stays the way to discard a
    // line.
    // Empty list first: `items.some(...)` is false on an empty array, so running
    // the vendor gate ahead of this blamed a missing vendor when the real
    // blocker was that the user had deleted every line.
    if (items.length === 0) { alert('Add at least one item'); return; }
    // The header vendor is OPTIONAL. One PO here legitimately spans several
    // vendors (it is an internal approval/costing document, not a sheet sent to
    // a vendor), and such a PO has no single header vendor — deriveHeaderVendor
    // writes "Mixed (N vendors)" from the lines. What the PO actually needs is a
    // vendor on every LINE, which is checked below and is what receive files
    // each purchase against.
    if (!primaryVendorId && !items.some(i => i.vendor.trim())) {
      alert('Pick a vendor — on the header, or per line.'); return;
    }
    const problems: string[] = [];
    // Same rule the route applies (deliveryDateError), said here first so the
    // buyer is not told after filling in the whole order. A vendor cannot
    // deliver before the order exists; every other date, including far-future
    // ones, is legitimate — a promised date is SUPPOSED to be ahead of today.
    if (deliveryDate && deliveryDate < date) {
      problems.push(`Expected delivery date ${deliveryDate} is before the PO date ${date} — a vendor cannot deliver before the order is placed.`);
    }
    items.forEach((it, i) => {
      const qty = Number(it.quantity);
      const px  = Number(it.unit_price);
      const mat = materials.find(m => m.id === it.material_id);
      const u   = poUnitOf(mat);
      if (!it.material_id)      problems.push(`Line ${i + 1}: select an item (or remove the line)`);
      else if (!(qty > 0))      problems.push(`Line ${i + 1}: enter a quantity greater than 0`);
      // A ₹0 / negative rate reaches the purchases row at receive and drags
      // average_price toward (or below) zero — never let it be saved.
      else if (!(px > 0))       problems.push(`Line ${i + 1}: enter a unit rate greater than 0 (₹ per ${u || 'purchase unit'})`);
      else if (!it.vendor.trim()) problems.push(`Line ${i + 1}: pick a vendor — receiving files the purchase against it`);
      else {
        // STRICT (vendor, item) mapping — same rule the server will apply, said
        // here first so the buyer is not told after a round trip.
        const bad = mappingProblem(i + 1, vm, it.vendor_id, it.vendor.trim(), it.material_id,
                                   mat ? `${mat.name}${mat.sku ? ` (${mat.sku})` : ''}` : it.material_id);
        if (bad) problems.push(bad);
      }
    });
    if (problems.length) {
      alert(problems.join('\n\n') +
        '\n\nVendor ↔ item mapping is maintained on Vendor Items (/vendors/materials): a vendor supplies a limited list of items, and an item can have several vendors.');
      return;
    }
    setSaving(true);
    try {
      const r = await api('/api/purchase-orders', {
        method: 'POST',
        body: {
          date,
          // NULL, not '': the column is nullable and "no promise on record" is a
          // real state the list renders as an em-dash. An empty string would
          // sort and compare as a date-shaped value that is not one.
          delivery_date: deliveryDate || null,
          notes,
          // Seed only: the route INSERTs the header with these, then
          // deriveHeaderVendor() rewrites it from the LINE vendors before the
          // same txn commits (one vendor → that line's vendor_id, several →
          // "Mixed (N)" with vendor_id NULL). Every line is validated above to
          // carry a vendor, so that derivation always wins; these are sent so a
          // PO raised here is never INSERTed vendor-less.
          vendor_id: primaryVendorId,
          vendor: primaryVendorName,
          // Items carry their own vendor. uid is client-only row identity.
          items: items.map(({ uid, ...line }) => line),
        },
      });
      if (!r.ok) { alert((await r.json()).error || 'Failed'); return; }
      onCreated(); onClose();
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      {/* House safe-modal shell: card capped to the viewport, BODY scrolls
          internally, header + footer pinned — so Save/Cancel are always on
          screen (previously the card grew ~1000px tall and Save sat below the
          fold on phones). The material-picker dropdown lives inside the
          scrollable body; its absolute panel extends the body's scroll area,
          so it stays reachable. */}
      <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
           className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-3xl shadow-xl flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
          <h2 className="font-bold text-[#2D1B0E]">New Purchase Order</h2>
          <button onClick={onClose} className="text-[#8B7355]">✕</button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
          {/* Header vendor is OPTIONAL: it seeds the line vendors and narrows the
              material list to that vendor's mapped items. A PO that spans several
              vendors just leaves it blank and sets the vendor per line. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <label className="text-xs text-[#6B5744] flex flex-col gap-1">
              Vendor <span className="text-[#8B7355] font-normal">(optional — filters the item list)</span>
              <select value={primaryVendorId} onChange={e => setPrimaryVendorId(e.target.value)}
                      className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm">
                <option value="">Select vendor…</option>
                {vendors.map(v => <option key={v.id} value={v.id}>{v.name}{v.payment_terms ? ` · ${v.payment_terms}` : ''}{v.lead_time_days ? ` · ${v.lead_time_days}d` : ''}</option>)}
              </select>
              {vendorLoadError && (
                <span className="text-[10px] text-red-600">{vendorLoadError}</span>
              )}
              {primaryVendorId && (
                <span className="text-[10px] text-[#8B7355]">
                  {!vm.ready ? 'Loading the vendor → item mapping…' :
                   headerItemCount > 0
                     ? <>Seeds every line. <strong>{headerItemCount}</strong> item{headerItemCount === 1 ? '' : 's'} mapped to {primaryVendorName} (<a href={vendorItemsHref(primaryVendorId)} target="_blank" rel="noopener noreferrer" className="text-[#af4408] underline">Vendor Items</a>)</>
                     : <>No items mapped to {primaryVendorName} yet.</>}
                </span>
              )}
            </label>
            <label className="text-xs text-[#6B5744] flex flex-col gap-1">
              PO Date
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                     className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
            </label>
            {/* When the vendor said it would arrive. Optional — plenty of orders
                are placed before a date is agreed — and the list flags it in red
                once it passes with goods still outstanding. */}
            <label className="text-xs text-[#6B5744] flex flex-col gap-1">
              Expected Delivery Date <span className="text-[#8B7355] font-normal">(optional)</span>
              <input type="date" value={deliveryDate} min={date}
                     onChange={e => setDeliveryDate(e.target.value)}
                     className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
              {/* min= is only a picker hint — a typed/pasted value slips past it.
                  Flag it live here; submit() blocks on the same test, which is
                  the rule the route itself enforces. */}
              {deliveryDate && deliveryDate < date && (
                <span className="text-[10px] text-amber-700">Earlier than the PO date — check this.</span>
              )}
            </label>
            <div className="text-xs text-[#6B5744] flex flex-col gap-1 justify-end">
              <span className="text-[10px] text-[#8B7355]">Vendor(s) on this PO</span>
              <div className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF1E3] text-sm font-medium text-[#2D1B0E] min-h-[34px]">
                {vendorSummary || <span className="text-[#8B7355] italic">{primaryVendorId ? 'Pick a material below — vendor auto-fills' : 'Set a vendor per line below, or pick one above ↑'}</span>}
              </div>
            </div>
          </div>
          {/* THE RULE, stated once at the top of the composer. */}
          {vm.error ? (
            <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-[11px] text-red-800 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <div className="flex-1">
                Could not load the vendor → item mapping ({vm.error}). Item and vendor pickers stay
                empty until it loads — a PO line is only accepted for a mapped pair.
              </div>
              <button type="button" onClick={vm.reload} className="underline font-medium shrink-0">Retry</button>
            </div>
          ) : (
            <div className="text-[10px] text-[#8B7355] flex items-center gap-1.5 flex-wrap">
              <Lock className="w-3 h-3 text-[#B8A590]" />
              A line may only pair a vendor with an item mapped to them: pick the vendor and the item
              list narrows, or pick the item and the vendor list narrows.
              <a href={VENDOR_ITEMS_HREF} target="_blank" rel="noopener noreferrer" className="text-[#af4408] underline">Vendor Items</a>
            </div>
          )}
          {/* THE EMPTY-MAP CASE — say it on screen, do not hand over an empty dropdown. */}
          {primaryVendorId && vm.ready && headerItemCount === 0 && (
            <NoItemsForVendor vendorId={primaryVendorId} vendorName={primaryVendorName} />
          )}
          {vm.ready && (
            <label className="flex items-start gap-2 text-[11px] text-[#6B5744]">
              <input type="checkbox" className="mt-0.5 shrink-0" checked={showAllMaterials} onChange={e => setShowAllMaterials(e.target.checked)} />
              <span className="flex-1 min-w-0">
                Also list items <em>not</em>{' '}mapped to the line&apos;s vendor — greyed, each with a one-click
                &quot;+ map &amp; use&quot; that declares the pair on Vendor Items and then puts it on the line.
              </span>
            </label>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-[#2D1B0E]">Items</h3>
              {/* Desktop keeps a quick top button; the primary one lives at the
                  bottom of the list so on mobile you always see it right after the
                  material you just added (rather than scrolled off the top). */}
              <button onClick={addLine} className="hidden md:flex text-xs text-[#af4408] hover:underline items-center gap-1">
                <Plus className="w-3 h-3" /> Add line
              </button>
            </div>
            <div ref={linesRef} className="overflow-x-auto">
            <table className="w-full text-xs block md:table md:min-w-[600px]">
              <thead className="text-[#8B7355] hidden md:table-header-group">
                <tr>
                  <th className="text-left py-1 px-2 font-medium" style={{ width: '34%' }}>Material</th>
                  <th className="text-left py-1 px-2 font-medium" style={{ width: '26%' }}>Vendor</th>
                  <th className="text-right py-1 px-2 font-medium w-16">Qty</th>
                  <th className="text-right py-1 px-2 font-medium w-20">Unit ₹</th>
                  <th className="text-right py-1 px-2 font-medium w-20">Line ₹</th>
                  <th className="w-8"></th>
                </tr>
              </thead>
              <tbody className="block md:table-row-group">
                {items.map((it, i) => {
                  const mat = materials.find(m => m.id === it.material_id);
                  const lineTotal = Number(it.quantity) * Number(it.unit_price);
                  // The vendor this line will actually be SAVED against: its own,
                  // else the header vendor that seeds it. Both dropdowns below are
                  // resolved from it, so the two halves of the line always agree.
                  const lineVendorId   = it.vendor_id || primaryVendorId;
                  const lineVendorName = it.vendor_id
                    ? (it.vendor || vendors.find(v => v.id === it.vendor_id)?.name || '')
                    : primaryVendorName;
                  const picks = pickListsFor(lineVendorId);
                  const vendorHasNoItems = !!lineVendorId && vm.ready && vm.itemCount(lineVendorId) === 0;
                  // A pair that is on the line but NOT declared — only reachable
                  // when the mapping changed under a line already filled in
                  // (another tab, another user). Never silently corrected: the
                  // buyer is shown the conflict and given the two ways out.
                  const pairConflict = !!it.material_id && !!it.vendor_id && vm.ready
                    && !vm.isMapped(it.vendor_id, it.material_id);
                  return (
                    <tr key={it.uid} className={`border-t border-[#E8D5C4]/50 align-top block md:table-row rounded-lg border border-[#E8D5C4] p-3 mb-2 space-y-2 md:p-0 md:mb-0 md:border-0 md:space-y-0 ${
                      flashLine === i + 1 ? 'ring-2 ring-[#af4408] bg-[#FFF1E3]' : ''}`}>
                      <td className="py-1 px-2 block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Material</span>
                        {/* Once an item is chosen the line is LOCKED to it — to
                            order a different item, remove the line and add a new
                            one. Swapping in place used to leave the previous
                            item's rate/vendor/contract behind on the line. */}
                        {mat ? (
                          <div className="px-2 py-1 rounded border border-[#E8D5C4] bg-[#FFF8F0] text-xs text-[#2D1B0E]">
                            <span className="font-mono text-[10px] text-[#8B7355] mr-1">{mat.sku}</span>{mat.name}
                          </div>
                        ) : vendorHasNoItems ? (
                          // Never an empty dropdown with no explanation.
                          <NoItemsForVendor compact vendorId={lineVendorId} vendorName={lineVendorName || 'This vendor'} />
                        ) : (
                          <SimpleMaterialPicker value={it.material_id} materials={picks.mapped}
                                              takenIds={takenIds} onPickTaken={goToTakenLine}
                                              stock={stock}
                                              disabled={!vm.ready}
                                              scopeNote={vm.ready
                                                ? (lineVendorId
                                                    ? `${picks.mapped.length} item${picks.mapped.length === 1 ? '' : 's'} mapped to ${lineVendorName || 'this vendor'}`
                                                    : 'Items with at least one mapped vendor — pick one and the vendor list narrows')
                                                : 'Loading the vendor → item mapping…'}
                                              unmapped={showAllMaterials ? picks.unmapped : []}
                                              unmappedLabel={lineVendorId
                                                ? `Not mapped to ${lineVendorName || 'this vendor'}`
                                                : 'No vendor mapped to these yet'}
                                              unmappedHint={lineVendorId
                                                ? 'Map the pair to order it — this is saved on Vendor Items.'
                                                : 'Pick a vendor on this line first, or map these on Vendor Items.'}
                                              mapBusy={mapBusy}
                                              onMapAndPick={lineVendorId ? async (m) => {
                                                const ok = await mapAndUse(lineVendorId, lineVendorName || 'this vendor', m);
                                                if (!ok) return;
                                                const taken = takenIds.get(m.id);
                                                if (taken && taken !== i + 1) { goToTakenLine(taken); return; }
                                                const patch: Partial<POLine> = { material_id: m.id };
                                                if (!it.unit_price) patch.unit_price = poRateOf(m);
                                                if (!it.vendor.trim()) {
                                                  patch.vendor    = lineVendorName;
                                                  patch.vendor_id = lineVendorId;
                                                }
                                                updateLine(i, patch);
                                              } : undefined}
                                              onChange={(id, m) => {
                                                // Belt-and-braces: keyboard selection or stale state could
                                                // reach here even though the row renders as un-pickable.
                                                const taken = takenIds.get(id);
                                                if (taken && taken !== i + 1) { goToTakenLine(taken); return; }
                                                const patch: Partial<POLine> = { material_id: id };
                                                // Seed ₹ per PURCHASE unit (kg), never the recipe unit (g).
                                                // Re-seeds on any material change too (belt-and-braces:
                                                // the line is locked above, so this can't go stale).
                                                if (m && (id !== it.material_id || !it.unit_price)) patch.unit_price = poRateOf(m);
                                                if (m && (!it.vendor || it.vendor.trim() === '')) {
                                                  // Phase 1 §3: vendor was picked at header level — default the line vendor to it.
                                                  // Falls back to the material's primary_vendor only if no header vendor was set.
                                                  // Resolve against the master FIRST: the line vendor is a dropdown now, so a
                                                  // name with no matching id can't be shown — leave it blank and make the
                                                  // user pick rather than seeding a value the select can't represent.
                                                  const seed = vendors.find(v => v.id === primaryVendorId)
                                                    || vendors.find(v => v.name.toLowerCase().trim() === String((m as any).primary_vendor || '').toLowerCase().trim());
                                                  patch.vendor    = seed ? seed.name : '';
                                                  patch.vendor_id = seed ? seed.id : '';
                                                }
                                                updateLine(i, patch);
                                              }} />
                        )}
                        {mat && (
                          <div className="text-[10px] text-[#8B7355] mt-0.5">
                            order unit {poUnitOf(mat)} · ₹{poRateOf(mat).toFixed(2)}/{poUnitOf(mat)}
                            {/* State the pack itself so the buyer knows what one
                                order unit contains — the kitchen's recipes are
                                written in the other unit. */}
                            {packNote(packMetaOfMat(mat)) && (
                              <span className="ml-1 text-[#B8A590]">· {packNote(packMetaOfMat(mat))}</span>
                            )}
                            <span className="ml-1 text-[#B8A590]">· 🗑 remove the line to change the item</span>
                          </div>
                        )}
                        {/* IN HAND, WHILE THE QUANTITY IS BEING DECIDED. Sits
                            directly above the Qty box on purpose: this is the
                            moment the buyer commits a number, and "3 kg is
                            already in the kitchen" belongs here, not on another
                            screen. Store and Dept stay two figures — a merged
                            total would hide the very split that answers the
                            question. Note the LIVE figure is what the buyer
                            reasons with; what the system will remember is the
                            snapshot taken the instant this PO is raised. */}
                        {mat && (
                          <StockOnHandNote data={stock.map.get(mat.id)} loading={stock.loading}
                                           variant="line" deptScope={stock.scope} visibleDepts={stock.visible}
                                           className="mt-1" />
                        )}
                      </td>
                      <td className="py-1 px-2 block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Vendor</span>
                        {/* Vendor must come FROM the master, not be typed. A typed
                            name that doesn't match a master row leaves vendor_id
                            empty, and every downstream join (contracts, vendor
                            history, payment terms) is keyed on vendor_id — so a
                            single typo silently cost the line its contract price.
                            Select by id; the name is cached alongside for display. */}
                        {(() => {
                          // A vendor deactivated AFTER this line was saved is no
                          // longer in `vendors`; keep it selectable so an existing
                          // draft still round-trips instead of blanking itself.
                          const knownVendor = vendors.some(v => v.id === it.vendor_id);
                          const legacy = !!it.vendor.trim() && !knownVendor;
                          // ITEM → VENDOR direction of the strict rule: once the
                          // item is known, only the vendors mapped to supply it
                          // are offered. An item can have MANY vendors, so this
                          // is a narrowing, never a single answer. The currently
                          // selected vendor is always kept in the list (flagged
                          // below) so the row never silently rewrites itself.
                          const offered = (it.material_id && vm.ready)
                            ? vendors.filter(v => vm.isMapped(v.id, it.material_id) || v.id === it.vendor_id)
                            : vendors;
                          return (
                            <>
                            <select
                              value={legacy ? '__legacy__' : (it.vendor_id || '')}
                              disabled={!vm.ready}
                              onChange={e => {
                                if (e.target.value === '__legacy__') return;   // unchanged
                                const v = vendors.find(x => x.id === e.target.value);
                                updateLine(i, { vendor_id: v ? v.id : '', vendor: v ? v.name : '' });
                              }}
                              className={`w-full px-1.5 py-1 border rounded text-xs bg-white disabled:opacity-60 ${legacy || pairConflict ? 'border-amber-400 bg-amber-50' : 'border-[#E8D5C4]'}`}
                            >
                              <option value="">Select vendor…</option>
                              {legacy && <option value="__legacy__">{it.vendor} — not in vendor master</option>}
                              {offered.map(v => (
                                <option key={v.id} value={v.id}>
                                  {v.name}
                                  {v.payment_terms ? ` · ${v.payment_terms}` : ''}
                                  {v.lead_time_days ? ` · ${v.lead_time_days}d lead` : ''}
                                  {it.material_id && vm.ready && !vm.isMapped(v.id, it.material_id) ? ' · NOT MAPPED' : ''}
                                </option>
                              ))}
                            </select>
                            {it.material_id && vm.ready && (
                              offered.length === 0 ? (
                                <div className="text-[10px] text-red-700 mt-0.5">
                                  No vendor is mapped to supply this item yet.{' '}
                                  <a href={VENDOR_ITEMS_HREF} target="_blank" rel="noopener noreferrer" className="underline">Map it on Vendor Items</a>
                                  {' '}(or remove the line).
                                </div>
                              ) : (
                                <div className="text-[9px] text-[#B8A590] mt-0.5">
                                  {offered.filter(v => vm.isMapped(v.id, it.material_id)).length} mapped vendor(s) for this item
                                </div>
                              )
                            )}
                            {pairConflict && (
                              <div className="text-[10px] text-red-700 mt-0.5">
                                ⚠ {lineVendorName || 'This vendor'} is not mapped to supply this item, so this line will be refused.{' '}
                                {mat && (
                                  <button type="button" disabled={mapBusy}
                                          onClick={async () => { await mapAndUse(it.vendor_id, lineVendorName || 'this vendor', mat); }}
                                          className="underline font-medium disabled:opacity-50">map it now</button>
                                )}
                                {' '}or pick a mapped vendor above.
                              </div>
                            )}
                            </>
                          );
                        })()}
                        <EligibleVendorChips
                          materialId={it.material_id}
                          currentVendor={it.vendor}
                          isMappedVendor={vm.ready ? (v => !!v.vendor_id && vm.isMapped(v.vendor_id, it.material_id)) : undefined}
                          onBlockedPick={v => alert(
                            `${v.vendor} has bought this item for you before, but the pair is not mapped, so a PO line cannot be filed against it.\n\n` +
                            `Map "${mat?.name || 'the item'}" to ${v.vendor} on Vendor Items (${VENDOR_ITEMS_HREF}), then pick them here.`
                          )}
                          onPick={v => {
                            // Chips come from purchase HISTORY, which can name a
                            // vendor the master no longer resolves. Re-resolve by
                            // name so the dropdown can actually show the pick
                            // instead of falling back to the legacy option.
                            const mv = vendors.find(x => x.id === v.vendor_id)
                                    || vendors.find(x => x.name.toLowerCase().trim() === v.vendor.toLowerCase().trim());
                            updateLine(i, {
                              vendor: mv ? mv.name : v.vendor,
                              vendor_id: mv ? mv.id : '',
                              // Contract beats last_price beats nothing.
                              // Always overwrite when a contract exists — that's the point.
                              // > 0, not != null: a ₹0 contract row means no rate was
                              // agreed and must not wipe a correctly seeded rate.
                              ...(Number(v.contract_price) > 0
                                  ? { unit_price: Number(v.contract_price) }
                                  : (!it.unit_price && Number(v.last_price) > 0 ? { unit_price: Number(v.last_price) } : {})),
                            });
                          }}
                        />
                        {it.vendor && it.vendor_id && (() => {
                          const v = vendors.find(x => x.id === it.vendor_id);
                          return v && (v.payment_terms || v.lead_time_days) ? (
                            <div className="text-[10px] text-[#8B7355] mt-0.5">
                              {v.payment_terms || ''}{v.payment_terms && v.lead_time_days ? ' · ' : ''}{v.lead_time_days ? `${v.lead_time_days}d lead` : ''}
                            </div>
                          ) : null;
                        })()}
                      </td>
                      <td className="py-1 px-2 block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Qty</span>
                        {/* min=0 + clamp: a negative qty/rate used to flow straight
                            through save → approve → receive into the purchases row
                            and average_price. Ordering can never be negative. */}
                        <input type="number" step="any" min={0} value={it.quantity || ''} data-po-qty={i + 1}
                               onChange={e => {
                                 const v = parseFloat(e.target.value);
                                 updateLine(i, { quantity: Number.isFinite(v) ? Math.max(0, v) : 0 });
                               }}
                               className="w-full px-1.5 py-1 border border-[#E8D5C4] rounded text-right text-xs" />
                        {/* Spell out the ORDER unit so qty can never be read as
                            the recipe/stock unit (g) — a PO is in kg/BTL/CASE.
                            The hint below reads the SAME typed number out in
                            recipe units; the box itself stays purchase-basis, so
                            what is posted is exactly what was typed. */}
                        {mat && <div className="text-[9px] text-[#8B7355] text-right mt-0.5">{poUnitOf(mat)}</div>}
                        {/* qty > 0 gate: the box renders blank at 0, so an
                            unconditional hint would read "= 0 g" under an empty
                            field the buyer has not filled in yet. */}
                        {mat && Number(it.quantity) > 0 && (
                          <div className={`${HINT_CLS} text-right`}>{recipeHint(Number(it.quantity), packMetaOfMat(mat))}</div>
                        )}
                      </td>
                      <td className="py-1 px-2 block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Unit ₹</span>
                        <input type="number" step="any" min={0} value={it.unit_price || ''}
                               onChange={e => {
                                 const v = parseFloat(e.target.value);
                                 updateLine(i, { unit_price: Number.isFinite(v) ? Math.max(0, v) : 0 });
                               }}
                               className="w-full px-1.5 py-1 border border-[#E8D5C4] rounded text-right text-xs" />
                        {mat && <div className="text-[9px] text-[#8B7355] text-right mt-0.5">/ {poUnitOf(mat)}</div>}
                        {/* The box renders blank at 0 (value={it.unit_price || ''}), which
                            reads as optional — say it out loud instead. */}
                        {it.material_id && !(Number(it.unit_price) > 0) && (
                          <div className="text-[9px] text-red-600 text-right mt-0.5">rate required</div>
                        )}
                        {it.material_id && it.vendor_id && (
                          <ContractFlag materialId={it.material_id} vendorId={it.vendor_id}
                                        unitPrice={Number(it.unit_price) || 0}
                                        onMatch={p => updateLine(i, { unit_price: p })} />
                        )}
                      </td>
                      <td className="py-1 px-2 text-right font-mono pt-2 block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Line ₹</span>
                        {fmt(lineTotal)}
                      </td>
                      <td className="py-1 px-2 pt-2 block md:table-cell">
                        <button onClick={() => removeLine(i)} className="text-red-500 hover:text-red-700">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="block md:table-footer-group">
                <tr className="border-t border-[#E8D5C4] font-semibold block md:table-row">
                  <td className="py-2 px-2 text-right block md:table-cell" colSpan={4}>Total</td>
                  <td className="py-2 px-2 text-right font-mono block md:table-cell">{fmt(total)}</td>
                  <td className="block md:table-cell"></td>
                </tr>
              </tfoot>
            </table>
            </div>
            {dupNote && (
              <div className="mt-2 flex items-start gap-2 rounded-lg border border-[#D4B896] bg-[#FFF1E3] px-3 py-2 text-[11px] text-[#6B5744]">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[#af4408]" />
                <span className="flex-1">{dupNote}</span>
                <button type="button" onClick={() => setDupNote(null)} className="text-[#8B7355] hover:text-[#2D1B0E]">✕</button>
              </div>
            )}
            {/* Primary Add-line — full width at the BOTTOM so after entering a
                material the button sits right below it (mobile-friendly). */}
            <button type="button" onClick={addLine}
                    className="mt-2 w-full flex items-center justify-center gap-1.5 py-2.5 border-2 border-dashed border-[#E8D5C4] rounded-lg text-sm font-medium text-[#af4408] hover:border-[#af4408] hover:bg-[#FFF1E3] active:bg-[#FFE8D5]">
              <Plus className="w-4 h-4" /> Add line
            </button>
          </div>

          <label className="text-xs text-[#6B5744] flex flex-col gap-1">
            Notes
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
                      className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
          </label>
        </div>
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-3 py-2 text-sm text-[#6B5744]">Cancel</button>
          <button onClick={submit} disabled={saving}
                  className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg disabled:opacity-50 inline-flex items-center gap-1">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Save as Draft
          </button>
        </div>
      </div>
    </div>
  );
}

/* Simple inline picker for the PO modal/edit (separate from the recipe picker so the file stays self-contained)
 *
 * ONE MATERIAL = ONE LINE. A PO carrying the same material twice double-orders,
 * and on receive it writes two purchases rows and bumps stock twice for one
 * item — which then skews that material's weighted-average cost. `takenIds`
 * maps material_id → the 1-based line it is already on; those rows stay VISIBLE
 * (hiding them reads as "we don't stock that") but cannot be picked, and
 * clicking one sends the user to the line that already has it. */
function SimpleMaterialPicker({
  value, materials, onChange, takenIds, onPickTaken,
  disabled, scopeNote, unmapped = [], unmappedLabel, unmappedHint, onMapAndPick, mapBusy,
  stock,
}: {
  value: string; materials: Material[]; onChange: (id: string, mat?: Material) => void;
  takenIds?: Map<string, number>; onPickTaken?: (lineNo: number) => void;
  /** LIVE in-hand stock for every material — Store and Departments, separately
   *  (CONTRACT §5.2). Optional and defaulted to undefined: when it is absent the
   *  dropdown renders exactly what it always has. The figure is read from the
   *  ONE batched /api/stock-on-hand call the parent modal makes at mount, never
   *  from a per-material or per-department fetch. */
  stock?: StockOnHandState;
  /** STRICT VENDOR ↔ ITEM MAPPING (all optional — callers that pass none get
   *  exactly the previous behaviour):
   *   disabled     — mapping not loaded yet; do not offer an unfiltered list
   *   scopeNote    — one line saying WHAT this list is ("155 items mapped to …")
   *   unmapped     — items outside the mapping, shown greyed BELOW the real list
   *                  (hiding them reads as "we don't stock that")
   *   onMapAndPick — the way out: declare the pair, then use it. Absent → the
   *                  greyed rows are informational only. */
  disabled?: boolean;
  scopeNote?: string;
  unmapped?: Material[];
  unmappedLabel?: string;
  unmappedHint?: string;
  onMapAndPick?: (m: Material) => void | Promise<void>;
  mapBusy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  // Portal the dropdown to <body> (fixed position) so the PO modal's overflow
  // can't clip it — the same clipping that hid this list inside the modal.
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const sel = materials.find(m => m.id === value) || unmapped.find(m => m.id === value);
  const matches = (m: Material, norm: string) =>
    !norm || m.name.toLowerCase().includes(norm) || (m.sku || '').toLowerCase().includes(norm);
  const list = useMemo(() => {
    const norm = q.toLowerCase().trim();
    return materials.filter(m => matches(m, norm)).slice(0, 1000);
  }, [q, materials]);
  /* The greyed half — same search box, so a buyer who types an item name always
     finds it, mapped or not, instead of concluding it does not exist. */
  const offMatches = useMemo(() => {
    const norm = q.toLowerCase().trim();
    return unmapped.filter(m => matches(m, norm));
  }, [q, unmapped]);
  const offList = useMemo(() => offMatches.slice(0, 200), [offMatches]);
  const computePos = () => {
    const el = ref.current;
    if (!el || typeof window === 'undefined') return;
    const r = el.getBoundingClientRect();
    const width = Math.max(r.width, 300);
    const left = Math.min(r.left, window.innerWidth - width - 8);
    setPos({ top: r.bottom + 4, left: Math.max(8, left), width });
  };
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    computePos();
    const onMove = () => computePos();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => { window.removeEventListener('scroll', onMove, true); window.removeEventListener('resize', onMove); };
  }, [open]);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !dropRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick); return () => document.removeEventListener('mousedown', onClick);
  }, []);
  return (
    <div ref={ref} className="relative">
      <button type="button" disabled={disabled} onClick={() => { setOpen(!open); setQ(''); }}
              className="w-full text-left px-2 py-1 border border-[#E8D5C4] rounded text-xs bg-[#FFF8F0] disabled:opacity-60 disabled:cursor-not-allowed">
        {sel ? (<><span className="text-[10px] font-mono text-[#8B7355] mr-1">{sel.sku}</span>{sel.name}</>)
             : <span className="text-[#8B7355]">{disabled ? 'Loading…' : 'Select…'}</span>}
      </button>
      {scopeNote && <div className="text-[9px] text-[#B8A590] mt-0.5">{scopeNote}</div>}
      {open && pos && typeof document !== 'undefined' && createPortal(
        <div ref={dropRef} style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}
             className="z-[100] max-w-[calc(100vw-1rem)] bg-white border border-[#D4B896] rounded shadow-lg p-2 max-h-[55vh] overflow-y-auto overscroll-contain">
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search SKU or name…"
                 className="w-full px-2 py-1 text-xs border border-[#E8D5C4] rounded mb-1 sticky top-0" />
          {/* The legend is pinned here, always, whenever the figure is shown:
              "Dept 3 kg*" is a different claim from "Dept 3 kg" and the reader
              must never have to guess which caveat a marker carries. */}
          {stock && <StockOnHandLegend className="px-1 pb-1" />}
          <div className="space-y-0.5">
            {list.length === 0 && (
              <div className="px-2 py-1 text-[11px] text-[#8B7355]">
                {q.trim() ? <>No mapped item matches &quot;{q}&quot;.</> : <>No materials loaded yet — refresh if this stays empty.</>}
                {unmapped.length > 0 && offList.length > 0 && <> Unmapped matches are listed below.</>}
              </div>
            )}
            {list.map(m => {
              const takenLine = takenIds?.get(m.id);
              return (
              <button type="button" key={m.id}
                      onClick={() => {
                        setOpen(false); setQ('');
                        if (takenLine) { onPickTaken?.(takenLine); return; }
                        onChange(m.id, m);
                      }}
                      title={takenLine ? `Already on line ${takenLine} — add the extra quantity there` : undefined}
                      className={`w-full text-left px-2 py-1 rounded text-xs flex flex-col items-stretch gap-0.5 ${
                        takenLine ? 'bg-[#FFF8F0] text-[#A08B76] cursor-default' : 'hover:bg-[#FFF1E3]'}`}>
                <span className="flex items-center gap-2 w-full">
                  <span className="text-[10px] font-mono text-[#8B7355] w-16 shrink-0">{m.sku || '·'}</span>
                  <span className="flex-1 min-w-0 truncate">{m.name}</span>
                  {takenLine ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#F0E4D6] text-[#8B7355] shrink-0">
                      already on line {takenLine}
                    </span>
                  ) : (<>
                    <span className="text-[10px] text-[#6B5744]">{poUnitOf(m)}</span>
                    {/* Rate carries its own basis: a bare "₹86.00" next to a list
                        of kitchen materials reads as ₹/g. poRateOf is already
                        ₹/purchase-unit — say which unit that is. */}
                    <span className="text-[10px] font-mono text-[#6B5744]">₹{poRateOf(m).toFixed(2)}/{poUnitOf(m)}</span>
                  </>)}
                </span>
                {/* IN HAND, BEFORE THE PICK (owner's ask #1). Store and Dept as
                    two figures on the pick list itself, so "do we already have
                    this?" is answered before the line exists — not after, on a
                    screen the buyer has to go and find. Shown on a taken row
                    too: that row is precisely where someone is deciding whether
                    to add MORE. */}
                {stock && (
                  <StockOnHandNote data={stock.map.get(m.id)} loading={stock.loading}
                                   variant="row" deptScope={stock.scope} visibleDepts={stock.visible}
                                   className="pl-[4.5rem] block" />
                )}
              </button>
              );
            })}
          </div>
          {/* THE GREYED HALF — items outside the mapping. Visible so the buyer
              can see the item exists and act, never silently selectable. */}
          {offList.length > 0 && (
            <div className="mt-2 border-t border-dashed border-[#D4B896] pt-1.5">
              <div className="px-2 pb-1 text-[10px] font-semibold text-[#A08B76] uppercase tracking-wide">
                {unmappedLabel || 'Not mapped'} · {offList.length}
              </div>
              {unmappedHint && <div className="px-2 pb-1 text-[10px] text-[#8B7355]">{unmappedHint}</div>}
              <div className="space-y-0.5">
                {offList.map(m => (
                  <div key={m.id} className="w-full px-2 py-1 rounded text-xs flex items-center gap-2 bg-[#FAF6F0] text-[#A08B76]">
                    <span className="text-[10px] font-mono w-16 shrink-0">{m.sku || '·'}</span>
                    <span className="flex-1 truncate">{m.name}</span>
                    <span className="text-[10px]">{poUnitOf(m)}</span>
                    {onMapAndPick ? (
                      <button type="button" disabled={mapBusy}
                              onClick={async () => { setOpen(false); setQ(''); await onMapAndPick(m); }}
                              className="text-[10px] px-1.5 py-0.5 rounded border border-[#af4408] text-[#af4408] hover:bg-[#FFF1E3] shrink-0 disabled:opacity-50">
                        + map &amp; use
                      </button>
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#F0E4D6] shrink-0">not mapped</span>
                    )}
                  </div>
                ))}
                {/* Only when the list was actually TRUNCATED — comparing against
                    the unfiltered total said "…772 more" under a single match. */}
                {offMatches.length > offList.length && (
                  <div className="px-2 py-1 text-[10px] text-[#B8A590]">
                    …{offMatches.length - offList.length} more — narrow with the search box.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

/* Inline edit of items (drafts only) */
function EditPOItems({ poId, initialDate, initialDeliveryDate, initialVendor, initialNotes, initialItems, materials, onCancel, onSaved }:
  { poId: string; initialDate: string; initialDeliveryDate?: string; initialVendor: string; initialNotes: string; initialItems: POItem[]; materials: Material[]; onCancel: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(initialDate);
  /* Seeded from the draft, blank when it has no promise on record. The `|| ''`
     keeps the input controlled — a NULL delivery_date would otherwise flip it to
     uncontrolled and React would warn on the first keystroke. slice(0,10)
     because <input type="date"> silently BLANKS anything that is not exactly
     YYYY-MM-DD, and a blanked field saves back as NULL — i.e. a promise the
     buyer never touched would be quietly erased by opening the editor. */
  const [deliveryDate, setDeliveryDate] = useState(String(initialDeliveryDate || '').slice(0, 10));
  const [notes, setNotes] = useState(initialNotes || '');
  // Lazy initializer — newLineUid() must be called once per row, not per render.
  const [items, setItems] = useState(() => initialItems.map(i => ({
    uid: newLineUid(),      // stable row identity — index keys leaked child state on remove
    material_id: i.material_id,
    quantity: i.quantity,
    unit_price: i.unit_price,
    vendor: (i as any).vendor || '',
    vendor_id: (i as any).vendor_id || '',
  })));
  const [vendors, setVendors] = useState<Array<{ id: string; name: string; payment_terms?: string; lead_time_days?: number }>>([]);
  const [saving, setSaving] = useState(false);
  const [showUnmapped, setShowUnmapped] = useState(false);
  const [mapBusy, setMapBusy] = useState(false);
  // Same strict (vendor, item) mapping as the new-PO composer, off the same
  // single payload. A draft is edited here and created there; a rule that
  // applied on only one of the two would just move the problem.
  const vm = useVendorItemIndex();
  /* Same ONE batched in-hand call as the composer, for the same reason: a line
     ADDED during an edit is a line being raised now, so the buyer needs the
     same two figures here that they would have had there. */
  const stock = useStockOnHand(true);

  // is_active filter matches the new-PO composer: a retired vendor must not be
  // offered for a fresh line. One already saved on this draft stays visible via
  // the select's legacy option, so editing an old draft never blanks its vendor.
  useEffect(() => {
    fetch('/api/vendors')
      .then(r => r.json())
      .then(d => setVendors((d.vendors || []).filter((v: any) => v.is_active)))
      .catch(() => {});
  }, []);

  const pickListsFor = useCallback((lineVendorId: string) => {
    if (!vm.ready) return { mapped: [] as Material[], unmapped: [] as Material[] };
    if (lineVendorId) {
      const ids = vm.itemsOf(lineVendorId);
      return { mapped: materials.filter(m => ids.has(m.id)), unmapped: materials.filter(m => !ids.has(m.id)) };
    }
    return {
      mapped:   materials.filter(m => vm.vendorsOf(m.id).length > 0),
      unmapped: materials.filter(m => vm.vendorsOf(m.id).length === 0),
    };
  }, [vm, materials]);

  /** Declare the pair from here — see the identical helper in the composer. */
  const mapAndUse = useCallback(async (vendorId: string, vendorName: string, mat: Material): Promise<boolean> => {
    if (!vendorId) return false;
    if (!window.confirm(
      `Map "${mat.name}" to ${vendorName}?\n\n` +
      `This says "${vendorName} supplies this item" and is saved on Vendor Items ` +
      `(mapping only — no price, no contract). It applies to every future PO.`
    )) return false;
    setMapBusy(true);
    try {
      const r = await api('/api/vendor-materials', { method: 'POST', body: { vendor_id: vendorId, material_id: mat.id } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { alert(j.error || `Could not map the item (HTTP ${r.status}).`); return false; }
      vm.reload();
      return true;
    } finally { setMapBusy(false); }
  }, [vm]);

  const update = (i: number, patch: any) => setItems(prev => prev.map((it, j) => j === i ? { ...it, ...patch } : it));
  /* material_id → the 1-based line it already sits on. Feeds the picker so a
     material that is already on this PO can't be added twice (one material =
     one line: a duplicate double-orders and, on receive, bumps stock twice). */
  const takenIds = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((l, idx) => { if (l.material_id && !m.has(l.material_id)) m.set(l.material_id, idx + 1); });
    return m;
  }, [items]);
  const [flashLine, setFlashLine] = useState<number | null>(null);
  const [dupNote, setDupNote] = useState<string | null>(null);
  // Scoped to THIS composer's rows — see the matching ref in the new-PO modal.
  const linesRef = useRef<HTMLDivElement | null>(null);
  /* Send the user to the line that already holds the item instead of silently
     doing nothing: focus its qty box, flash the row, and say where it went. */
  const goToTakenLine = (lineNo: number) => {
    const existing = items[lineNo - 1];
    const mat = materials.find(mm => mm.id === existing?.material_id);
    setDupNote(`${mat?.name || 'That item'} is already on line ${lineNo} — add the extra quantity there.`);
    setFlashLine(lineNo);
    setTimeout(() => setFlashLine(null), 1400);
    setTimeout(() => {
      const el = (linesRef.current || document).querySelector<HTMLInputElement>(`[data-po-qty="${lineNo}"]`);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el?.focus(); el?.select();
    }, 0);
  };

  const add = () => setItems(prev => [...prev, { uid: newLineUid(), material_id: '', quantity: 1, unit_price: 0, vendor: '', vendor_id: '' }]);
  const remove = (i: number) => setItems(prev => prev.filter((_, j) => j !== i));

  const save = async () => {
    // PUT replaces the whole item list, so an empty list silently WIPED the
    // draft's items (total_cost 0) and a blank row was silently dropped. Validate
    // per row, and never send an empty list.
    if (items.length === 0) {
      alert('A PO needs at least one item. To scrap this PO, use Delete on the draft instead.');
      return;
    }
    const problems: string[] = [];
    // Same rule as the new-PO composer and as the route (deliveryDateError):
    // a vendor cannot deliver before the order is placed.
    if (deliveryDate && deliveryDate < date) {
      problems.push(`Expected delivery date ${deliveryDate} is before the PO date ${date} — a vendor cannot deliver before the order is placed.`);
    }
    items.forEach((it, i) => {
      const qty = Number(it.quantity);
      const px  = Number(it.unit_price);
      const mat = materials.find(m => m.id === it.material_id);
      const u   = poUnitOf(mat);
      if (!it.material_id)      problems.push(`Line ${i + 1}: select an item (or remove the line)`);
      else if (!(qty > 0))      problems.push(`Line ${i + 1}: enter a quantity greater than 0`);
      // ₹0 / negative rates reach the purchases row at receive and drag
      // average_price toward zero.
      else if (!(px > 0))       problems.push(`Line ${i + 1}: enter a unit rate greater than 0 (₹ per ${u || 'purchase unit'})`);
      else if (!it.vendor.trim()) problems.push(`Line ${i + 1}: pick a vendor — receiving files the purchase against it`);
      else {
        // STRICT (vendor, item) mapping — the server applies the same rule.
        const bad = mappingProblem(i + 1, vm, it.vendor_id, it.vendor.trim(), it.material_id,
                                   mat ? `${mat.name}${mat.sku ? ` (${mat.sku})` : ''}` : it.material_id);
        if (bad) problems.push(bad);
      }
    });
    if (problems.length) {
      // State it as POLICY, because it is one: Smart Reorder deliberately files
      // drafts with a blank line vendor and a 0 rate (lib/crm-reorder-po.ts) for
      // the buyer to complete here. Editing such a draft therefore means
      // finishing every line, not just the one you came to change — approve and
      // receive both reject a zero rate anyway.
      alert(
        problems.join('\n') +
        '\n\nA draft is only saved once every line is complete (item + qty + rate + vendor). ' +
        'Smart Reorder drafts arrive with the vendor and rate blank on purpose — fill those in here.'
      );
      return;
    }
    setSaving(true);
    try {
      const r = await api('/api/purchase-orders', {
        method: 'PUT',
        // uid is client-only row identity — strip it off the wire.
        // delivery_date goes as NULL when cleared, so a promise can be withdrawn
        // as well as set — see the composer for why not ''.
        body: { id: poId, date, delivery_date: deliveryDate || null, notes, items: items.map(({ uid, ...line }) => line) },
      });
      if (!r.ok) { alert((await r.json()).error || 'Failed'); return; }
      onSaved();
    } finally { setSaving(false); }
  };

  return (
    <div ref={linesRef} className="space-y-3">
      {/* These three boxes carried no labels at all: two bare date pickers and a
          placeholder are not enough to tell a buyer which date is which, and
          getting them the wrong way round makes the PO permanently overdue. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <label className="flex flex-col gap-1 text-[#6B5744]">
          PO Date
          <input type="date" value={date} onChange={e => setDate(e.target.value)} className="px-2 py-1 border border-[#E8D5C4] rounded" />
        </label>
        <label className="flex flex-col gap-1 text-[#6B5744]">
          Expected Delivery Date
          <input type="date" value={deliveryDate} min={date} onChange={e => setDeliveryDate(e.target.value)}
                 className="px-2 py-1 border border-[#E8D5C4] rounded" />
          {deliveryDate && deliveryDate < date && (
            <span className="text-[10px] text-amber-700">Earlier than the PO date — check this.</span>
          )}
        </label>
        <label className="flex flex-col gap-1 text-[#6B5744] col-span-2">
          Notes
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes" className="px-2 py-1 border border-[#E8D5C4] rounded" />
        </label>
      </div>
      {/* Strict mapping — same rule and same wording as the new-PO composer. */}
      {vm.error ? (
        <div className="rounded border border-red-300 bg-red-50 px-2 py-1.5 text-[10px] text-red-800 flex items-start gap-1.5">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <span className="flex-1">Vendor → item mapping did not load ({vm.error}). Pickers stay empty until it does.</span>
          <button type="button" onClick={vm.reload} className="underline font-medium">Retry</button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 flex-wrap text-[10px] text-[#8B7355]">
          <span className="inline-flex items-center gap-1">
            <Lock className="w-3 h-3 text-[#B8A590]" />
            A line only accepts a vendor mapped to the item (and an item mapped to the vendor).
            <a href={VENDOR_ITEMS_HREF} target="_blank" rel="noopener noreferrer" className="text-[#af4408] underline">Vendor Items</a>
          </span>
          {vm.ready && (
            <label className="inline-flex items-center gap-1.5 text-[#6B5744]">
              <input type="checkbox" checked={showUnmapped} onChange={e => setShowUnmapped(e.target.checked)} />
              show unmapped items (with &quot;+ map&quot;)
            </label>
          )}
        </div>
      )}
      <div className="grid grid-cols-12 gap-2 text-[10px] text-[#8B7355] font-medium px-1">
        <div className="col-span-4">Material</div>
        <div className="col-span-3">Vendor</div>
        <div className="col-span-2 text-right">Qty</div>
        <div className="col-span-1 text-right">Unit ₹</div>
        <div className="col-span-1 text-right">Line ₹</div>
        <div className="col-span-1"></div>
      </div>
      {items.map((it, i) => {
        const mat = materials.find(m => m.id === it.material_id);
        const lineVendorId   = it.vendor_id || '';
        const lineVendorName = it.vendor || vendors.find(v => v.id === lineVendorId)?.name || '';
        const picks = pickListsFor(lineVendorId);
        const vendorHasNoItems = !!lineVendorId && vm.ready && vm.itemCount(lineVendorId) === 0;
        const pairConflict = !!it.material_id && !!lineVendorId && vm.ready && !vm.isMapped(lineVendorId, it.material_id);
        return (
          <div key={it.uid} className={`grid grid-cols-12 gap-2 text-xs items-start rounded ${
            flashLine === i + 1 ? 'ring-2 ring-[#af4408] bg-[#FFF1E3]' : ''}`}>
            <div className="col-span-4">
              {/* Locked once chosen — remove the line to order a different item. */}
              {mat ? (
                <div className="px-2 py-1 rounded border border-[#E8D5C4] bg-[#FFF8F0] text-xs text-[#2D1B0E]">
                  <span className="font-mono text-[10px] text-[#8B7355] mr-1">{mat.sku}</span>{mat.name}
                  <div className="text-[9px] text-[#8B7355]">
                    order unit {poUnitOf(mat)} · ₹{poRateOf(mat).toFixed(2)}/{poUnitOf(mat)}
                    {packNote(packMetaOfMat(mat)) && <span className="ml-1 text-[#B8A590]">· {packNote(packMetaOfMat(mat))}</span>}
                  </div>
                  {/* Live Store + Dept, same renderer and same wording as the
                      new-PO composer — the two screens must never describe the
                      same material differently. */}
                  <StockOnHandNote data={stock.map.get(mat.id)} loading={stock.loading}
                                   variant="line" deptScope={stock.scope} visibleDepts={stock.visible}
                                   className="mt-1" />
                </div>
              ) : vendorHasNoItems ? (
                <NoItemsForVendor compact vendorId={lineVendorId} vendorName={lineVendorName || 'This vendor'} />
              ) : (
                <SimpleMaterialPicker value={it.material_id} materials={picks.mapped}
                                      takenIds={takenIds} onPickTaken={goToTakenLine}
                                      stock={stock}
                                      disabled={!vm.ready}
                                      scopeNote={vm.ready
                                        ? (lineVendorId
                                            ? `${picks.mapped.length} item${picks.mapped.length === 1 ? '' : 's'} mapped to ${lineVendorName || 'this vendor'}`
                                            : 'Items with at least one mapped vendor')
                                        : 'Loading the vendor → item mapping…'}
                                      unmapped={showUnmapped ? picks.unmapped : []}
                                      unmappedLabel={lineVendorId ? `Not mapped to ${lineVendorName || 'this vendor'}` : 'No vendor mapped to these yet'}
                                      unmappedHint={lineVendorId
                                        ? 'Map the pair to order it — this is saved on Vendor Items.'
                                        : 'Pick a vendor on this line first, or map these on Vendor Items.'}
                                      mapBusy={mapBusy}
                                      onMapAndPick={lineVendorId ? async (m) => {
                                        const ok = await mapAndUse(lineVendorId, lineVendorName || 'this vendor', m);
                                        if (!ok) return;
                                        const taken = takenIds.get(m.id);
                                        if (taken && taken !== i + 1) { goToTakenLine(taken); return; }
                                        const patch: any = { material_id: m.id };
                                        if (!it.unit_price) patch.unit_price = poRateOf(m);
                                        update(i, patch);
                                      } : undefined}
                                      onChange={(id, m) => {
                  // Belt-and-braces — see the matching guard in the new-PO composer.
                  const taken = takenIds.get(id);
                  if (taken && taken !== i + 1) { goToTakenLine(taken); return; }
                  const patch: any = { material_id: id };
                  // ₹ per PURCHASE unit (kg) — never the raw recipe-unit average.
                  if (m && (id !== it.material_id || !it.unit_price)) patch.unit_price = poRateOf(m);
                  if (m && (!it.vendor || it.vendor.trim() === '')) {
                    // Only seed a vendor the dropdown can actually show — see the
                    // matching comment in the new-PO composer.
                    const dv = (m as any).primary_vendor || '';
                    const mv = vendors.find(v => v.name.toLowerCase().trim() === dv.toLowerCase().trim());
                    patch.vendor    = mv ? mv.name : '';
                    patch.vendor_id = mv ? mv.id : '';
                  }
                  update(i, patch);
                }} />
              )}
            </div>
            <div className="col-span-3">
              {/* Pick from the master — a typed name leaves vendor_id empty and
                  silently breaks every vendor_id-keyed join. Same rule as the
                  new-PO composer, including the legacy escape hatch. */}
              {(() => {
                const knownVendor = vendors.some(v => v.id === it.vendor_id);
                const legacy = !!it.vendor.trim() && !knownVendor;
                // ITEM → VENDOR: only vendors mapped to this item (an item can
                // have many). The line's current vendor is always kept in the
                // list, flagged, so the row never rewrites itself silently.
                const offered = (it.material_id && vm.ready)
                  ? vendors.filter(v => vm.isMapped(v.id, it.material_id) || v.id === it.vendor_id)
                  : vendors;
                return (
                  <>
                  <select
                    value={legacy ? '__legacy__' : (it.vendor_id || '')}
                    disabled={!vm.ready}
                    onChange={e => {
                      if (e.target.value === '__legacy__') return;
                      const v = vendors.find(x => x.id === e.target.value);
                      update(i, { vendor_id: v ? v.id : '', vendor: v ? v.name : '' });
                    }}
                    className={`w-full px-1.5 py-1 border rounded text-xs bg-white disabled:opacity-60 ${legacy || pairConflict ? 'border-amber-400 bg-amber-50' : 'border-[#E8D5C4]'}`}
                  >
                    <option value="">Select vendor…</option>
                    {legacy && <option value="__legacy__">{it.vendor} — not in vendor master</option>}
                    {offered.map(v => (
                      <option key={v.id} value={v.id}>
                        {v.name}{it.material_id && vm.ready && !vm.isMapped(v.id, it.material_id) ? ' · NOT MAPPED' : ''}
                      </option>
                    ))}
                  </select>
                  {it.material_id && vm.ready && offered.length === 0 && (
                    <div className="text-[10px] text-red-700 mt-0.5">
                      No vendor is mapped to supply this item.{' '}
                      <a href={VENDOR_ITEMS_HREF} target="_blank" rel="noopener noreferrer" className="underline">Map it on Vendor Items</a>.
                    </div>
                  )}
                  {pairConflict && (
                    <div className="text-[10px] text-red-700 mt-0.5">
                      ⚠ {lineVendorName || 'This vendor'} is not mapped to supply this item — this line will be refused.{' '}
                      {mat && (
                        <button type="button" disabled={mapBusy}
                                onClick={async () => { await mapAndUse(lineVendorId, lineVendorName || 'this vendor', mat); }}
                                className="underline font-medium disabled:opacity-50">map it now</button>
                      )}
                    </div>
                  )}
                  </>
                );
              })()}
              <EligibleVendorChips
                materialId={it.material_id}
                currentVendor={it.vendor}
                isMappedVendor={vm.ready ? (v => !!v.vendor_id && vm.isMapped(v.vendor_id, it.material_id)) : undefined}
                onBlockedPick={v => alert(
                  `${v.vendor} has supplied this item before, but the pair is not mapped, so a PO line cannot be filed against it.\n\n` +
                  `Map "${mat?.name || 'the item'}" to ${v.vendor} on Vendor Items (${VENDOR_ITEMS_HREF}), then pick them here.`
                )}
                onPick={v => {
                  // Re-resolve the history name against the master so the select
                  // can show it — see the new-PO composer.
                  const mv = vendors.find(x => x.id === v.vendor_id)
                          || vendors.find(x => x.name.toLowerCase().trim() === v.vendor.toLowerCase().trim());
                  update(i, {
                    vendor: mv ? mv.name : v.vendor,
                    vendor_id: mv ? mv.id : '',
                    // > 0, not != null — a ₹0 contract row is "no rate agreed" and
                    // must not overwrite a correctly seeded rate with 0.
                    ...(Number(v.contract_price) > 0
                        ? { unit_price: Number(v.contract_price) }
                        : (!it.unit_price && Number(v.last_price) > 0 ? { unit_price: Number(v.last_price) } : {})),
                  });
                }}
              />
            </div>
            {/* min=0 + clamp — a negative ordered qty/rate is never re-checked at
                receive (only overrides are) so it would reach purchases. */}
            <div className="col-span-2">
              <input type="number" step="any" min={0} value={it.quantity || ''} data-po-qty={i + 1}
                     onChange={e => { const v = parseFloat(e.target.value); update(i, { quantity: Number.isFinite(v) ? Math.max(0, v) : 0 }); }}
                     className="w-full px-2 py-1 border border-[#E8D5C4] rounded text-right" />
              {/* Same labels as the new-PO composer: a PO is in kg/BTL/CASE at
                  ₹/purchase-unit, and here the basis was stated only in the
                  material cell — which wraps out of line on a narrow screen
                  while this box rewrites a live PO's money. */}
              {mat && <div className="text-[9px] text-[#8B7355] text-right mt-0.5">{poUnitOf(mat)}</div>}
              {/* qty > 0 gate — see the matching note in the new-PO composer. */}
              {mat && Number(it.quantity) > 0 && (
                <div className={`${HINT_CLS} text-right`}>{recipeHint(Number(it.quantity), packMetaOfMat(mat))}</div>
              )}
            </div>
            <div className="col-span-1">
              <input type="number" step="any" min={0} value={it.unit_price || ''}
                     onChange={e => { const v = parseFloat(e.target.value); update(i, { unit_price: Number.isFinite(v) ? Math.max(0, v) : 0 }); }}
                     className="w-full px-2 py-1 border border-[#E8D5C4] rounded text-right" />
              {mat && <div className="text-[9px] text-[#8B7355] text-right mt-0.5">/ {poUnitOf(mat)}</div>}
              {it.material_id && it.vendor_id && (
                <ContractFlag materialId={it.material_id} vendorId={it.vendor_id}
                              unitPrice={Number(it.unit_price) || 0}
                              onMatch={p => update(i, { unit_price: p })} />
              )}
            </div>
            {/* The two boxes immediately above are this row's qty and rate,
                labelled poUnitOf(mat) and / poUnitOf(mat); a PO line is stored
                in PURCHASE units at Rs/purchase-unit.
                rate-basis: purchase */}
            <div className="col-span-1 text-right font-mono pt-1">{fmt((it.quantity || 0) * (it.unit_price || 0))}</div>
            <button onClick={() => remove(i)} className="col-span-1 text-red-500"><Trash2 className="w-3 h-3" /></button>
          </div>
        );
      })}
      <div className="flex items-center justify-between">
        <button onClick={add} className="text-xs text-[#af4408]"><Plus className="w-3 h-3 inline" /> Add line</button>
        <div className="flex gap-2">
          <button onClick={onCancel} className="text-xs text-[#6B5744]">Cancel</button>
          <button onClick={save} disabled={saving} className="px-3 py-1.5 text-xs bg-[#af4408] hover:bg-[#8a3506] text-white rounded disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ */
/* Approval Context Panel — last 2 purchases + usage + flags     */
/* Helps admin spot stockpiling / panic ordering before approving */
/* ============================================================ */
const FLAG_DEF: Record<string, { label: string; tone: string; help: string }> = {
  over_order:        { label: 'Over-order',         tone: 'bg-red-100 text-red-700 border-red-200',          help: 'Requested qty + current stock would exceed your last 90 days of consumption' },
  recent_purchase:   { label: 'Bought recently',    tone: 'bg-amber-100 text-amber-800 border-amber-200',    help: 'Last purchase was less than 7 days ago' },
  price_jump:        { label: 'Price jump >10%',    tone: 'bg-indigo-100 text-indigo-700 border-indigo-200', help: 'Requested unit price is more than 10% above weighted average' },
  overstock:         { label: 'Already overstocked',tone: 'bg-amber-100 text-amber-800 border-amber-200',    help: 'Current stock alone covers >60 days of usage' },
  no_recent_usage:   { label: 'No recent usage',    tone: 'bg-rose-100 text-rose-700 border-rose-200',       help: 'Item has stock but zero consumption in the last 90 days' },
};

function ApprovalContextPanel({ poId }: { poId: string }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/purchase-orders/${poId}/approval-context`)
      .then(async r => { if (!r.ok) throw new Error((await r.json()).error || 'Failed'); return r.json(); })
      .then(setData).catch(e => setErr(e.message)).finally(() => setLoading(false));
  }, [poId]);

  if (loading) return <tr><td colSpan={8} className="px-3 py-4 bg-amber-50/30 text-xs text-[#8B7355]">Loading approval context…</td></tr>;
  if (err)     return <tr><td colSpan={8} className="px-3 py-4 bg-red-50 text-xs text-red-700">Error: {err}</td></tr>;
  if (!data)   return null;

  return (
    <tr><td colSpan={8} className="bg-amber-50/30 px-3 py-3 border-b border-amber-200">
      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <AlertTriangle className="w-4 h-4 text-amber-700" />
          <span className="text-sm font-semibold text-amber-900">Approval Review</span>
          <span className="text-xs text-[#6B5744]">— check past purchases, current stock, and consumption before approving</span>
          {data.summary.total_flags > 0 ? (
            <span className="ml-auto text-xs text-red-700 font-semibold">⚠ {data.summary.total_flags} flag(s)</span>
          ) : (
            <span className="ml-auto text-xs text-green-700 font-semibold">✓ No flags — looks clean</span>
          )}
        </div>

        <div className="bg-white border border-amber-200 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-amber-50 text-[#6B5744]">
              <tr>
                <th className="text-left  py-1.5 px-2 font-medium">Item</th>
                <th className="text-right py-1.5 px-2 font-medium">Requested</th>
                <th className="text-right py-1.5 px-2 font-medium">Current Stock</th>
                <th className="text-right py-1.5 px-2 font-medium">Used 30 / 60 / 90 d</th>
                <th className="text-right py-1.5 px-2 font-medium">Days of Stock</th>
                <th className="text-left  py-1.5 px-2 font-medium">Last 2 purchases</th>
                <th className="text-left  py-1.5 px-2 font-medium">Flags</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((it: any) => {
                // requested_qty is in PURCHASE units (10 kg) while current_stock and
                // the usage columns are in RECIPE units (2,000 g) — they differ by
                // pack_size, so they must not be labelled the same nor divided
                // directly. ONE resolution per row through the shared guard: the
                // "pack > 1 AND the units differ" test lives in packFactor() and is
                // never re-derived here, because a local copy is exactly how one
                // cell in a row ends up on the other basis.
                const meta   = packMetaOf(it);
                // Never blank — the API COALESCEs purchase_unit to the recipe unit.
                // Used for EVERY column, including pack-1 materials (pcs vs BTL):
                // labelling stock "pcs" beside a request in "BTL" is the same
                // sibling mismatch, even when the two numbers happen to be equal.
                const poUnit = String(meta.purchase_unit || '').trim() || it.material_unit;
                const pf     = packFactor(meta);
                const reqInStockUnits = (Number(it.requested_qty) || 0) * pf;
                // Recipe-basis columns → purchase basis for the lead figure.
                const stockPU = toPurchaseQty(it.current_stock, meta);
                const usePU   = (v: number) => fmtQtyNum(toPurchaseQty(v, meta));
                // % of stock — recipe ÷ recipe, so it is basis-independent and
                // must NOT be recomputed from the rounded purchase figures.
                const reqVsStock = it.current_stock > 0 && it.requested_qty > 0
                  ? `+${((reqInStockUnits / it.current_stock) * 100).toFixed(0)}%`
                  : null;
                return (
                  <tr key={it.po_item_id} className={`border-t border-amber-100 ${it.flags.length > 0 ? 'bg-red-50/20' : ''}`}>
                    <td className="py-2 px-2">
                      <div className="font-medium text-[#2D1B0E]">{it.material_name}</div>
                      <div className="text-[10px] font-mono text-[#8B7355]">{it.material_sku}</div>
                    </td>
                    <td className="py-2 px-2 text-right font-mono">
                      {/* Already PURCHASE units (canon) — printed, never divided. */}
                      <div className="font-semibold">{fmtQtyNum(it.requested_qty)} {poUnit}</div>
                      {/* Always state the basis: a bare "@ ₹151.50" beside the
                          recipe-unit columns reads as ₹/g. poUnit is never blank
                          — the API COALESCEs purchase_unit to the recipe unit. */}
                      <div className="text-[10px] text-[#8B7355]">@ ₹{it.requested_unit_price.toFixed(2)}/{poUnit}</div>
                      {/* Spell out the stock-unit equivalent so "10 kg" can be compared
                          with the recipe-unit figures the kitchen works in. */}
                      {pf > 1 && (
                        <div className={HINT_CLS}>= {fmtQtyNum(reqInStockUnits)} {it.material_unit}</div>
                      )}
                    </td>
                    <td className="py-2 px-2 text-right font-mono">
                      {/* Purchase basis (owner rule): current_stock is recipe units;
                          toPurchaseQty so "2 BTL on hand" reads as 2, not 1500. */}
                      <div>{fmtQtyNum(stockPU)} {poUnit}</div>
                      {pf > 1 && <div className={HINT_CLS}>= {fmtQtyNum(it.current_stock)} {it.material_unit}</div>}
                      {reqVsStock && <div className="text-[10px] text-[#8B7355]">order is {reqVsStock} of stock</div>}
                    </td>
                    <td className="py-2 px-2 text-right font-mono text-[#6B5744]">
                      {/* Consumption is stored in recipe units; converted so it
                          reads against the Requested and Current Stock columns
                          without the reader dividing by the pack in their head. */}
                      {usePU(it.usage_30d)} / {usePU(it.usage_60d)} / {usePU(it.usage_90d)}
                      <div className="text-[10px] text-[#8B7355]">{poUnit}{it.avg_daily_usage_30d > 0 ? ` · avg ${toPurchaseQty(it.avg_daily_usage_30d, meta).toFixed(2)}/day` : ''}</div>
                      {pf > 1 && (
                        <div className={HINT_CLS}>
                          = {fmtQtyNum(it.usage_30d)} / {fmtQtyNum(it.usage_60d)} / {fmtQtyNum(it.usage_90d)} {it.material_unit}
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-2 text-right font-mono">
                      {it.days_of_stock != null
                        ? <span className={it.days_of_stock > 60 ? 'text-amber-700 font-semibold' : it.days_of_stock < 7 ? 'text-red-600 font-semibold' : 'text-[#2D1B0E]'}>
                            {Math.round(it.days_of_stock)} days
                          </span>
                        : <span className="text-[#8B7355]">—</span>}
                    </td>
                    <td className="py-2 px-2">
                      {it.last_purchases.length === 0 ? (
                        <span className="text-[10px] text-[#8B7355]">No history</span>
                      ) : (
                        <div className="space-y-0.5">
                          {it.last_purchases.map((p: any, i: number) => (
                            <div key={i} className="text-[10px]">
                              <span className="text-[#6B5744]">{dateLabel(p.date)}</span>
                              {/* purchases.quantity/unit_price are PURCHASE-unit
                                  basis (canon) — say so, or "10 × ₹900" beside
                                  the recipe-unit stock column reads as 10 g. */}
                              <span className="ml-1 font-mono">{p.quantity.toLocaleString('en-IN')} {poUnit} × ₹{p.unit_price.toFixed(2)}/{poUnit}</span>
                              <span className="ml-1 text-[#8B7355]">· {p.vendor || 'unknown'}</span>
                            </div>
                          ))}
                          {it.days_since_last_purchase != null && (
                            <div className="text-[10px] text-[#8B7355]">{it.days_since_last_purchase}d ago</div>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-2">
                      {it.flags.length === 0 ? (
                        <span className="text-[10px] text-green-700">✓ ok</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {it.flags.map((f: string) => {
                            const def = FLAG_DEF[f] || { label: f, tone: 'bg-gray-100 text-gray-700 border-gray-200', help: '' };
                            return (
                              <span key={f} title={def.help}
                                    className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded border ${def.tone}`}>
                                {def.label}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {data.summary.total_flags > 0 && (
          <div className="text-[10px] text-[#6B5744]">
            <span className="font-semibold">Tip:</span> hover any flag for an explanation. Common pattern — store keeps ordering an item where stock already covers months of usage.
            Reject and ask the requester to verify stock first.
          </div>
        )}
      </div>
    </td></tr>
  );
}

/* ============================================================ */
/* Reject PO Modal — quick templates + optional email to drafter */
/* ============================================================ */
const REJECT_TEMPLATES: Array<{ key: string; label: string; reason: string }> = [
  { key: 'overstock',    label: 'Stock too high',
    reason: 'We already have enough stock to cover the next several weeks of usage. Please verify physical stock before re-ordering.' },
  { key: 'no_usage',     label: 'Item not selling',
    reason: 'This item has had no consumption recently. Please confirm there is real demand before stocking up further.' },
  { key: 'price_high',   label: 'Price too high',
    reason: 'The unit price on this PO is significantly above our recent weighted average. Please get a better quote or use a different vendor.' },
  { key: 'wrong_vendor', label: 'Wrong vendor',
    reason: 'Please source from our preferred vendor for this item — better terms / faster lead time / proven quality.' },
  { key: 'duplicate',    label: 'Duplicate / recent PO',
    reason: 'A recent PO for the same item is still pending or was received within the last few days. Avoid duplicate ordering.' },
  { key: 'incomplete',   label: 'Needs more info',
    reason: 'Please add the supplier invoice / quotation reference and confirm the brand/specifications before re-submitting.' },
];

function RejectPOModal({ po, onClose, onRejected }: {
  po: PO;
  onClose: () => void;
  onRejected: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const [emailDrafter, setEmailDrafter] = useState(true);
  const [busy, setBusy] = useState(false);

  // Drafted_by stores the user email (per Phase 10 changes); fall back to it for the mailto.
  const drafterEmail = (po.drafted_by || '').includes('@') ? po.drafted_by : '';

  const pickTemplate = (k: string) => {
    const t = REJECT_TEMPLATES.find(x => x.key === k);
    if (!t) return;
    setPickedKey(k);
    setReason(t.reason);
  };

  const buildMailto = (finalReason: string) => {
    const subject = encodeURIComponent(`PO ${po.po_number} rejected — please review`);
    const body = encodeURIComponent(
      `Hi,\n\nYour purchase order ${po.po_number} dated ${po.date} (vendor: ${po.vendor || 'unspecified'}, total ${fmt(po.total_cost)}) was rejected.\n\nReason:\n${finalReason}\n\nPlease address the above and re-submit.\n\nThanks.`,
    );
    return `mailto:${encodeURIComponent(drafterEmail || '')}?subject=${subject}&body=${body}`;
  };

  const submit = async () => {
    if (!reason.trim()) { alert('Please pick a template or write a reason.'); return; }
    setBusy(true);
    try {
      await onRejected(reason.trim());
      // Open mail client AFTER reject succeeds so the action is recorded first
      if (emailDrafter && drafterEmail) {
        window.open(buildMailto(reason.trim()), '_blank');
      }
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-xl my-8 shadow-xl">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between">
          <div>
            <h2 className="font-bold text-[#2D1B0E] inline-flex items-center gap-2">
              <XCircle className="w-5 h-5 text-red-600" /> Reject {po.po_number}
            </h2>
            <p className="text-xs text-[#8B7355] mt-0.5">Pick a quick reason or write your own. The requester will see this on the PO.</p>
          </div>
          <button onClick={onClose} className="text-[#8B7355]">✕</button>
        </div>

        <div className="p-5 space-y-4">
          {/* Quick templates */}
          <div>
            <label className="text-xs font-semibold text-[#6B5744]">Quick reasons</label>
            <div className="flex flex-wrap gap-2 mt-2">
              {REJECT_TEMPLATES.map(t => (
                <button key={t.key} type="button" onClick={() => pickTemplate(t.key)}
                        className={`px-2.5 py-1.5 text-xs rounded-md border transition-colors ${
                          pickedKey === t.key
                            ? 'bg-red-600 text-white border-red-600'
                            : 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100'
                        }`}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Reason textarea */}
          <label className="block text-xs text-[#6B5744]">
            Reason
            <textarea value={reason} onChange={e => { setReason(e.target.value); setPickedKey(null); }}
                      rows={4}
                      placeholder="Type a custom reason or tap a quick reason above…"
                      className="w-full mt-1 px-3 py-2 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
          </label>

          {/* Mailto option */}
          <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3 text-xs space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={emailDrafter && !!drafterEmail} disabled={!drafterEmail}
                     onChange={e => setEmailDrafter(e.target.checked)} />
              <span className="font-semibold text-[#2D1B0E]">Email the requester</span>
              {drafterEmail
                ? <span className="text-[#6B5744]">→ <code className="bg-white px-1 rounded">{drafterEmail}</code></span>
                : <span className="text-[#8B7355]">(no email on file — drafter user has no email)</span>}
            </label>
            {emailDrafter && drafterEmail && (
              <p className="text-[10px] text-[#8B7355]">
                Opens your default email client with the PO summary &amp; reason pre-filled — you just hit Send.
              </p>
            )}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 text-sm text-[#6B5744]">Cancel</button>
          <button onClick={submit} disabled={busy || !reason.trim()}
                  className="px-3 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
            Reject{emailDrafter && drafterEmail ? ' & Email' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ */
/* Approve PO Modal — confirms approval, requires note if flags  */
/* ============================================================ */
function ApprovePOModal({ po, onClose, onApproved }: {
  po: PO;
  onClose: () => void;
  onApproved: (note: string) => Promise<void>;
}) {
  const [ctx, setCtx] = useState<any>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/purchase-orders/${po.id}/approval-context`)
      .then(r => r.json()).then(setCtx).finally(() => setLoading(false));
  }, [po.id]);

  const flagCount = ctx?.summary?.total_flags || 0;
  const requiresNote = flagCount > 0;
  const canSubmit = !requiresNote || note.trim().length >= 10;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try { await onApproved(note.trim()); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-xl my-8 shadow-xl">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between">
          <div>
            <h2 className="font-bold text-[#2D1B0E] inline-flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-blue-600" /> Approve {po.po_number}
            </h2>
            <p className="text-xs text-[#8B7355] mt-0.5">Vendor: {po.vendor || '—'} · Total: {fmt(po.total_cost)}</p>
          </div>
          <button onClick={onClose} className="text-[#8B7355]">✕</button>
        </div>

        <div className="p-5 space-y-4">
          {loading ? (
            <div className="text-center text-xs text-[#8B7355] py-3">Checking flags…</div>
          ) : flagCount === 0 ? (
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-xs text-green-800 inline-flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">No flags raised</div>
                <div>This PO passes all auto-checks. You can approve directly.</div>
              </div>
            </div>
          ) : (
            <>
              <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-xs text-amber-900">
                <div className="font-semibold inline-flex items-center gap-1">
                  <AlertTriangle className="w-4 h-4" /> {flagCount} flag(s) detected
                </div>
                <div className="mt-1">
                  Please justify the override. The note becomes part of the audit trail and is visible
                  on the PO history alongside your name.
                </div>
                <ul className="mt-2 space-y-0.5">
                  {(['over_order','recent_purchase','price_jump','overstock','no_recent_usage'] as const).map(k => {
                    const n = ctx?.summary?.[`${k}_count`] || 0;
                    if (!n) return null;
                    const label = (FLAG_DEF[k] || { label: k }).label;
                    return <li key={k}>• <span className="font-mono">{n}×</span> {label}</li>;
                  })}
                </ul>
              </div>

              <label className="block text-xs text-[#6B5744]">
                Override note <span className="text-red-600">*</span>
                <textarea value={note} onChange={e => setNote(e.target.value)}
                          rows={3}
                          placeholder="e.g. Confirmed with vendor that price jump is one-time festival surcharge…"
                          className="w-full mt-1 px-3 py-2 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
                <span className="text-[10px] text-[#8B7355]">Minimum 10 characters.</span>
              </label>
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 text-sm text-[#6B5744]">Cancel</button>
          <button onClick={submit} disabled={busy || !canSubmit}
                  className="px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
            {requiresNote ? 'Approve with override' : 'Approve'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ */
/* Edit an APPROVED PO's lines — add items / change quantities,
 * same PO, forced re-approval.
 *
 * Backend: POST /api/purchase-orders/[id]/edit-approved. It REPLACES the whole
 * line set, drops the PO to 'pending_reapproval' (clearing the old approval),
 * and hard-refuses (409, naming the GRNs) once ANY goods are received — the
 * button that opens this modal is already disabled on part-received rows for
 * that reason. The route also snapshots stock for materials NEW to the PO at
 * this moment; originals keep their raise-time figure (first-write-wins), which
 * is the owner's rule for the "Stock when PO raised" column.
 *
 * Deliberately SIMPLER than the Create/Draft composers: rates are read-only
 * here (a wrong rate on undelivered goods is corrected at Receive, which takes
 * an override with a reason — the route's own header says so), and new lines
 * take their vendor from a small select over the vendors already on this PO
 * (header vendor first). The full vendor↔item mapping machinery stays on the
 * composer paths where vendors are actually being chosen. */
function EditApprovedPOModal({ po, materials, onClose, onSaved }: {
  po: PO; materials: Material[]; onClose: () => void; onSaved: () => void;
}) {
  type EditLine = {
    id?: string; material_id: string; material_name: string; purchase_unit: string;
    quantity: string;          // raw keystrokes — committed on save (the rate-draft lesson)
    unit_price: number; vendor: string; vendor_id: string | null; notes: string;
    isNew: boolean;
  };
  const [lines, setLines] = useState<EditLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/purchase-orders?id=${po.id}`).then(r => r.json()).then(d => {
      const items: POItem[] = d.purchase_order?.items || [];
      setLines(items.map(it => ({
        id: it.id, material_id: it.material_id,
        material_name: it.material_name || it.material_id,
        purchase_unit: it.material_purchase_unit || '',
        quantity: String(it.quantity),
        unit_price: it.unit_price,
        vendor: it.vendor || '', vendor_id: it.vendor_id ?? null,
        notes: it.notes || '', isNew: false,
      })));
      setLoading(false);
    }).catch(() => { setError('Failed to load the PO lines. Close and retry.'); setLoading(false); });
  }, [po.id]);

  /* Vendor choices for NEW lines: the header vendor plus every vendor already
   * on a line. A blank choice is allowed only when the PO has a header vendor —
   * the route resolves a blank line vendor to the header at receive time. */
  const vendorChoices = useMemo(() => {
    const seen = new Map<string, { id: string | null; name: string }>();
    if (po.vendor) seen.set(po.vendor, { id: (po as any).vendor_id ?? null, name: po.vendor });
    for (const l of lines) if (l.vendor) seen.set(l.vendor, { id: l.vendor_id, name: l.vendor });
    return [...seen.values()];
  }, [po, lines]);

  const takenIds = useMemo(() => {
    const m = new Map<string, number>();
    lines.forEach((l, i) => { if (l.material_id) m.set(l.material_id, i + 1); });
    return m;
  }, [lines]);

  const addLine = () => setLines(ls => [...ls, {
    material_id: '', material_name: '', purchase_unit: '',
    quantity: '1', unit_price: 0,
    vendor: vendorChoices.length === 1 ? vendorChoices[0].name : (po.vendor || ''),
    vendor_id: vendorChoices.length === 1 ? vendorChoices[0].id : ((po as any).vendor_id ?? null),
    notes: '', isNew: true,
  }]);

  // Both factors are PURCHASE basis: POItem.quantity and unit_price are declared
  // purchase-unit on the interface, and new lines seed from poRateOf (Rs/purchase
  // unit) with a qty typed against the purchase unit shown beside the box.
  const total = lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (l.unit_price || 0), 0); // rate-basis: purchase
  const invalid = lines.some(l => !l.material_id || !(Number(l.quantity) > 0) || !(l.unit_price > 0));
  const changed = lines.some(l => l.isNew) || true; // qty edits are cheap to allow through; server refuses no-ops harmlessly

  const submit = async () => {
    setBusy(true); setError('');
    try {
      const r = await api(`/api/purchase-orders/${po.id}/edit-approved`, {
        method: 'POST',
        body: {
          reason,
          items: lines.map(l => ({
            id: l.id, material_id: l.material_id,
            quantity: Number(l.quantity) || 0, unit_price: l.unit_price,
            vendor: l.vendor, vendor_id: l.vendor_id, notes: l.notes,
          })),
        },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error || 'Failed to save the edit.'); return; }
      alert(`${po.po_number} updated — it is back in Pending Approval and needs a fresh admin approval before it can be received.`);
      onSaved();
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3">
      <div className="bg-white rounded-xl w-full max-w-2xl flex flex-col" style={{ maxHeight: 'calc(100vh - 1.5rem)' }}>
        <div className="px-5 py-3 border-b border-[#E8D5C4]">
          <h3 className="font-bold text-[#2D1B0E]">Edit items — {po.po_number}</h3>
          <p className="text-[11px] text-[#6B5744] mt-0.5">
            {po.vendor ? <>Vendor: <span className="font-medium">{po.vendor}</span> · </> : null}
            Add items or change quantities. Saving sends this PO back for a fresh admin approval —
            nothing can be received until it is re-approved. Rates are corrected at Receive, not here.
          </p>
        </div>
        <div className="px-5 py-3 overflow-y-auto flex-1 space-y-2">
          {loading ? (
            <div className="text-sm text-[#8B7355] flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading lines…</div>
          ) : (
            <>
              {lines.map((l, i) => (
                <div key={l.id || `new-${i}`} className="border border-[#E8D5C4] rounded-lg p-2.5 space-y-1.5">
                  {l.isNew && !l.material_id ? (
                    <SimpleMaterialPicker value={l.material_id} materials={materials}
                                          takenIds={takenIds}
                                          onPickTaken={() => setError('That item is already on the PO — change its quantity instead.')}
                                          onChange={(id, m) => setLines(ls => ls.map((x, xi) => {
                                            if (xi !== i) return x;
                                            /* VENDOR SEED, primary-first. The header vendor may not be
                                               MAPPED to supply this item — the route's strict pairing
                                               check refuses that with a 400 — so the material's own
                                               primary vendor wins when it has one, and the header is
                                               the fallback. vendor_id stays null for a primary-seeded
                                               name: the route's vendorResolver resolves names against
                                               the master ID-first-then-name, so a bare name is valid. */
                                            const primary = String((m as any)?.primary_vendor || '').trim();
                                            return {
                                              ...x, material_id: id,
                                              material_name: m?.name || id,
                                              purchase_unit: m ? poUnitOf(m) : '',
                                              unit_price: m ? poRateOf(m) : 0,
                                              vendor: primary || x.vendor,
                                              vendor_id: primary ? null : x.vendor_id,
                                            };
                                          }))} />
                  ) : (
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <span className="text-sm font-medium text-[#2D1B0E]">{l.material_name}</span>
                        {l.isNew && <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-green-100 text-green-700 align-middle">ADDED</span>}
                        {/* The vendor ALWAYS shows: a line with a blank vendor is
                            received under the PO's header vendor, and hiding that
                            read as "no vendor" (owner report, 2026-08-16). */}
                        <span className="ml-1.5 text-[10px] text-[#8B7355]">
                          {l.vendor || (po.vendor ? `${po.vendor} (PO vendor)` : '— no vendor —')}
                        </span>
                      </div>
                      <button onClick={() => setLines(ls => ls.filter((_, xi) => xi !== i))}
                              className="p-1 rounded text-red-500 hover:bg-red-50 shrink-0" title="Remove this line">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                  {l.material_id && (
                    <div className="flex items-center gap-3 text-xs">
                      <label className="text-[#6B5744]">Qty
                        <input type="number" min="0.01" step="any" value={l.quantity}
                               onChange={e => setLines(ls => ls.map((x, xi) => xi === i ? { ...x, quantity: e.target.value } : x))}
                               className="ml-1.5 w-24 border border-[#E8D5C4] rounded px-2 py-1 font-mono" />
                        {l.purchase_unit && <span className="ml-1 text-[#8B7355]">{l.purchase_unit}</span>}
                      </label>
                      <span className="text-[#8B7355] font-mono">₹{l.unit_price.toFixed(2)}{l.purchase_unit ? `/${l.purchase_unit}` : ''}</span>
                      {/* purchase qty x Rs/purchase-unit — same basis on both sides */}
                      <span className="ml-auto font-mono text-[#2D1B0E]">₹{((Number(l.quantity) || 0) * l.unit_price).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span> {/* rate-basis: purchase */}
                      {l.isNew && (() => {
                        /* Options = this line's current vendor (covers the
                           primary-vendor seed, which may not be on the PO yet)
                           ∪ the vendors already on the PO. Rendered even with a
                           single option so the vendor is always VISIBLE on an
                           added line (owner report: "vendor is not showing"). */
                        const names = [...new Set([l.vendor, ...vendorChoices.map(c => c.name)].filter(Boolean))];
                        return (
                          <select value={l.vendor}
                                  onChange={e => {
                                    const name = e.target.value;
                                    const v = vendorChoices.find(c => c.name === name);
                                    setLines(ls => ls.map((x, xi) => xi === i ? { ...x, vendor: name, vendor_id: v?.id ?? null } : x));
                                  }}
                                  className="border border-[#E8D5C4] rounded px-1.5 py-1 text-[11px]">
                            {po.vendor && !l.vendor ? null : (l.vendor ? null : <option value="">— vendor —</option>)}
                            {names.map(n => <option key={n} value={n}>{n}</option>)}
                          </select>
                        );
                      })()}
                    </div>
                  )}
                </div>
              ))}
              <button onClick={addLine}
                      className="w-full border border-dashed border-[#D4B896] rounded-lg py-2 text-xs text-[#6B5744] hover:bg-[#FFF1E3] inline-flex items-center justify-center gap-1">
                <Plus className="w-3.5 h-3.5" /> Add item
              </button>
              <div>
                <label className="block text-xs text-[#6B5744] mb-1">Reason for the change (required — goes in the approval note)</label>
                <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2}
                          placeholder="e.g. Vendor confirmed 5 more cases available / quantity corrected after stock check"
                          className="w-full border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm" />
              </div>
              {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">{error}</div>}
            </>
          )}
        </div>
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-between gap-2">
          <span className="text-xs text-[#6B5744]">New total <span className="font-mono font-semibold">₹{total.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span></span>
          <div className="flex gap-2">
            <button onClick={onClose} disabled={busy} className="px-3 py-2 text-sm text-[#6B5744]">Cancel</button>
            <button onClick={submit}
                    disabled={busy || loading || invalid || lines.length === 0 || !reason.trim() || !changed}
                    className="px-3 py-2 text-sm bg-amber-500 hover:bg-amber-600 text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Save &amp; send for re-approval
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
