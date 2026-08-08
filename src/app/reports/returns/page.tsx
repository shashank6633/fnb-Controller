'use client';

/**
 * RETURN REPORT (/reports/returns) — requirement 79, management only.
 *
 * The owner's words, row 79: "Generate a Return Report with Item Name, PO No.,
 * GRN No., Return Ticket Raised By, Date & Time, Approved By, Reason, Status,
 * and Quantity. Include both Vendor Returns and Internal Department Returns."
 * Every one of those nine facts is on the row below, and the two kinds share
 * one list — which is exactly why they do not share a total.
 *
 * Reads GET /api/reports/returns (isManagement-gated, same gate and same
 * wording as /api/reports/issue-log and /api/reports/purchase-log — this page
 * joins vendor rates and rupee valuations onto material rows, which is the
 * commercially sensitive content those two are already gated on). The
 * operational returns board the store and the departments work on every day
 * keeps its own narrower gate and is untouched; nobody loses a screen.
 *
 * This page is the third sibling of /reports/purchases and /reports/issue-log.
 * Read the header of src/app/reports/issue-log/page.tsx first — the totals
 * discipline below is inherited from it wholesale, and only what is DIFFERENT
 * here is written out again.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO FACTS A READER MUST HAVE BEFORE THEY READ A SINGLE NUMBER ON THIS PAGE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. STOCK MOVES ONLY WHEN THE STORE ACCEPTS A LINE. Nowhere else, and at no
 *    earlier step. Raising a ticket moves nothing. The Department Head
 *    approving it moves nothing — a ticket sitting at `hod_approved` means the
 *    goods are standing at the store counter and the books have not changed by
 *    one gram. A ticket that was cancelled or HOD-rejected, and any individual
 *    LINE the store rejected, left stock exactly where it was.
 *    On a live board the COMMON case is a row that moved nothing at all, which
 *    is why every row carries Stock effect and why each total says how many of
 *    its lines actually moved. Reading a requested quantity as though the grams
 *    had already travelled is the misreading this page is shaped to prevent.
 *
 * 2. A VENDOR RETURN AND AN INTERNAL RETURN HAVE OPPOSITE EFFECTS ON CENTRAL
 *    STOCK.
 *      VENDOR    goods go BACK OUT TO THE VENDOR. They leave the building.
 *                CENTRAL STOCK DECREASES. The money is a CREDIT NOTE the
 *                vendor owes us — a claim, not a spend.
 *      INTERNAL  goods come from a DEPARTMENT back to the CENTRAL STORE. They
 *                stay in the building. DEPARTMENT STOCK DECREASES and CENTRAL
 *                STOCK INCREASES. The money is a valued memo; nobody paid
 *                anybody.
 *    A third case hides inside the internal half: a line marked wastage or
 *    disposal takes the DEPARTMENT down and does NOT credit central, because
 *    unusable goods must never re-enter the sellable pool. That is why Stock
 *    effect has three movement values and is not a synonym for Source.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THEREFORE: TWO TOTALS CARDS, AND NEVER A THIRD ONE COVERING BOTH
 * ═══════════════════════════════════════════════════════════════════════════
 * purchase-log refuses a grand total because one delivery is legitimately
 * written into three tables. issue-log refuses one because its stages are
 * measured in different bases. This report refuses one for a harder reason
 * still: ITS TWO SOURCES POINT IN OPPOSITE DIRECTIONS ON THE SAME SCALAR.
 * 40 kg returned to a vendor plus 15 kg handed back by the kitchen is not 55 kg
 * of anything — central stock fell 40 and rose 15. The two also carry different
 * kinds of money (a claim on a vendor versus a memo valuation of goods that
 * never left the company) and are captured in different unit bases.
 *
 * So the totals render as SEPARATE per-source cards, each printing the server's
 * own `basis` sentence VERBATIM — never paraphrased, never merged, never
 * shortened — and there is deliberately no combined figure anywhere on this
 * page. If you are ever tempted to add a "total returns" card here, re-read
 * this block: that single number is the bug, and it is precisely the number
 * that gets quoted.
 *
 * A SECOND, QUIETER SUMMING TRAP, guarded below: even WITHIN one source a
 * quantity total is only meaningful when a single item is selected. 4 kg of
 * flour plus 3 L of oil is not 7 of anything, so the server withholds the
 * figure (`requested_qty === null`) and the card prints a sentence saying why.
 * A blank cell beside a populated line count reads as "nothing came back", so
 * the caption is not optional. Do not "fix" that by always showing the number.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UNITS — the purchase figure is TAKEN FROM THE SERVER, never derived here
 * ═══════════════════════════════════════════════════════════════════════════
 * OWNER RULE: every Purchase and Inventory surface LEADS with the PURCHASE unit
 * (kg / L / BTL). So every quantity on this page leads with `purchase_qty` +
 * `purchase_unit` straight off the wire, and the recipe figure appears only as
 * a declared "= 3,000 g" hint underneath.
 *
 * This page performs NO unit conversion of its own. src/lib/return-log.ts
 * derives the purchase figure once, through pack-units' toPurchaseQty(), which
 * carries the both-halves guard (pack_size > 1 AND unit !== purchase_unit) —
 * which is why PICKLED GINGER 1.5KG (unit kg, purchase_unit kg, pack 1.5) does
 * NOT convert. Dividing by pack_size by hand here would re-derive that rule
 * badly and quietly render a 6 kg return as 4 kg. There is no arithmetic on a
 * quantity in this file at all.
 *
 * MONEY is likewise server-computed. Every rupee figure shown is `rate` (Rs per
 * PURCHASE unit) or a value the lib already multiplied out against a
 * PURCHASE-unit quantity, so no rate meets a quantity on this page and no basis
 * can be crossed here. raw_materials.last_purchase_price is never read, here or
 * anywhere — it is stored in mixed bases.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DISPOSAL & WASTAGE (requirement 78's "separate reports")
 * ═══════════════════════════════════════════════════════════════════════════
 * `disposition` is a code on the LINE — reusable | wastage | disposal — not a
 * second ledger. Requirement 78's separate report is therefore this report cut
 * by that code: the Disposal & Wastage section below is its own visually
 * distinct block listing ONLY lines whose disposition is not `reusable`, and
 * the Disposition filter narrows the whole report (and the CSV) to one code.
 * The section is derived from the rows already on screen, so it can never
 * disagree with the table above it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { todayIST } from '@/lib/format-date';
import MaterialTypeahead, { type MaterialLite } from '@/components/MaterialTypeahead';
import {
  Undo2, Download, AlertTriangle, Info, Loader2, Truck, Building2,
  Trash2, CalendarDays, ShieldAlert, CircleSlash, PackageX, Receipt,
} from 'lucide-react';

/* ═══════════════════════════════ WIRE CONTRACT ═══════════════════════════════
 * Mirrors src/lib/return-log.ts. Kept as a local copy of the shape rather than
 * a type import so the page compiles independently of the lib's build order;
 * the field names are the contract and must not drift.
 */

type ReturnSource = 'VENDOR' | 'INTERNAL';
type ReturnDisposition = 'reusable' | 'wastage' | 'disposal';
/** See the header: this is NOT a synonym for source. */
type StockEffect = 'CENTRAL_DOWN' | 'CENTRAL_UP' | 'DEPARTMENT_DOWN' | 'NONE';

interface ReturnLogRow {
  source: ReturnSource;

  ret_number: string;
  return_id: string;
  line_id: string;

  date: string;
  raised_at: string;

  raised_by: string;
  /** The DEPT HEAD / MANAGER of req 73 — never the store verifier, who is separate. */
  approved_by: string;
  approved_at: string;
  verified_by: string;
  verified_at: string;

  status: string;
  ticket_status: string;

  department_id: string | null;
  department: string;
  vendor: string;

  po_no: string;
  grn_no: string;

  material_id: string;
  material: string;
  sku: string;
  category: string;

  /** As typed, in `unit`. Shown only as a footnote — the lead is purchase. */
  qty: number;
  unit: string;
  qty_basis: 'line';
  recipe_qty: number;
  recipe_unit: string;
  /** THE LEAD FIGURE. Server-derived through toPurchaseQty(); never re-derived here. */
  purchase_qty: number;
  purchase_unit: string;

  /** What the store actually accepted — the grams that MOVED. */
  accepted_qty: number;
  accepted_recipe_qty: number;
  accepted_purchase_qty: number;

  reason: string;
  store_reject_reason: string;
  disposition: ReturnDisposition;

  /** Rs per PURCHASE unit. Displayed, never multiplied on this page. */
  rate: number | null;
  rate_basis: 'purchase' | '';
  rate_source: string;
  requested_value: number | null;
  accepted_value: number | null;
  value_basis: 'credit_note' | 'memo' | '';

  stock_moved: boolean;
  stock_effect: StockEffect;
  dept_txn_id: string;
  inv_txn_id: string;
  /** An accepted line missing a movement receipt it should have. An integrity fault. */
  receipt_missing: boolean;

  notes: string;
}

interface SourceTotal {
  source: ReturnSource;
  lines: number;
  tickets: number;
  moved_lines: number;
  wastage_lines: number;
  disposal_lines: number;
  /** null unless a single item is filtered — see the header. */
  requested_qty: number | null;
  accepted_qty: number | null;
  qty_unit: string;
  qty_basis: 'purchase';
  requested_value: number;
  accepted_value: number;
  value_basis: 'credit_note' | 'memo';
  /** Printed VERBATIM beneath the card. Never paraphrased on screen. */
  basis: string;
}

interface ReturnLogResponse {
  rows: ReturnLogRow[];
  totals: {
    vendor: SourceTotal;
    internal: SourceTotal;
    by_source: SourceTotal[];
    /** A COUNT OF ROWS — never a quantity, never money. Not a third total. */
    lines: number;
    basis: string;
    sources_present: ReturnSource[];
  };
  truncated: boolean;
  from: string;
  to: string;
}

/* ═════════════════════════════ presentation maps ═════════════════════════════ */

const SOURCE_META: Record<ReturnSource, {
  label: string; short: string; badge: string; icon: React.ReactNode; direction: string;
}> = {
  VENDOR: {
    label: 'Vendor returns', short: 'VENDOR',
    badge: 'bg-[#FDEEEA] text-[#9A3412] border-[#F5D0C2]',
    icon: <Truck className="w-4 h-4" />,
    direction: 'Goods leave the building — central stock DECREASES.',
  },
  INTERNAL: {
    label: 'Internal department returns', short: 'INTERNAL',
    badge: 'bg-[#EDF4EE] text-[#3F6B4C] border-[#CFE2D4]',
    icon: <Building2 className="w-4 h-4" />,
    direction: 'Goods come back from a department — central stock INCREASES.',
  },
};

/** Fixed order so the two cards never swap places between loads. */
const SOURCE_ORDER: ReturnSource[] = ['VENDOR', 'INTERNAL'];

/**
 * The server's own token, normalised. Belt-and-braces in the same spirit as
 * issue-log's normStage(): this page and src/lib/return-log.ts ship in the same
 * change but are written separately, and an unrecognised token here would throw
 * on the badge lookup and blank the whole table.
 *
 * It falls back to VENDOR deliberately, not to INTERNAL. The two directions are
 * opposite, so a wrong guess is not neutral — VENDOR is the reading that says
 * "stock left the building", which is the one that gets questioned. Silently
 * labelling an unknown row as an internal return would quietly assert that
 * central stock went UP.
 */
function normSource(raw: unknown): ReturnSource {
  return String(raw || '').toUpperCase().trim() === 'INTERNAL' ? 'INTERNAL' : 'VENDOR';
}

/**
 * ?source= values, matching GET /api/reports/returns' SOURCES exactly — the
 * route 400s on anything else (deliberately: the lib would silently coerce an
 * unknown token to "all" and hand back BOTH sources under a heading that says
 * one), so this list is a contract, not a convenience.
 */
const SOURCE_FILTERS = [
  { k: 'all', label: 'Both kinds of return' },
  { k: 'vendor', label: 'Vendor returns only (stock out)' },
  { k: 'internal', label: 'Internal returns only (stock back in)' },
] as const;
type SourceFilter = (typeof SOURCE_FILTERS)[number]['k'];

/** ?disposition= — requirement 78's cut. Same contract, same 400 on anything else. */
const DISPOSITION_FILTERS = [
  { k: 'all', label: 'Any disposition' },
  { k: 'reusable', label: 'Reusable only' },
  { k: 'wastage', label: 'Wastage only' },
  { k: 'disposal', label: 'Disposal only' },
] as const;
type DispositionFilter = (typeof DISPOSITION_FILTERS)[number]['k'];

/**
 * ?status= is the TICKET's status and must be one of the module's own six
 * (src/lib/returns.ts RETURN_STATUSES). Spelled out here rather than imported so
 * this client page carries no server-lib import; the route validates the value
 * against the real list, so a drift shows as a 400 and not as a page of
 * confident zeros.
 */
const STATUS_FILTERS = [
  { k: '', label: 'Any status' },
  { k: 'draft', label: 'Draft — not submitted' },
  { k: 'submitted', label: 'Submitted — awaiting the Dept Head' },
  { k: 'hod_approved', label: 'Approved by Dept Head — at the store, nothing moved yet' },
  { k: 'verified', label: 'Store verified — the only status that moves stock' },
  { k: 'hod_rejected', label: 'Rejected by Dept Head — nothing moved' },
  { k: 'cancelled', label: 'Cancelled — nothing moved' },
] as const;

/** The line's own outcome, which is not always the ticket's. */
const LINE_STATUS_META: Record<string, { label: string; tone: string }> = {
  DRAFT:                { label: 'Draft',            tone: 'bg-[#F4EFE9] text-[#6B5744] border-[#E8D5C4]' },
  SUBMITTED:            { label: 'Submitted',        tone: 'bg-[#F4EFE9] text-[#6B5744] border-[#E8D5C4]' },
  HOD_APPROVED:         { label: 'HOD approved',     tone: 'bg-[#FFF1E3] text-[#af4408] border-[#F0CDAE]' },
  HOD_REJECTED:         { label: 'HOD rejected',     tone: 'bg-[#FDEEEA] text-[#9A3412] border-[#F5D0C2]' },
  CANCELLED:            { label: 'Cancelled',        tone: 'bg-[#F4EFE9] text-[#8B7355] border-[#E8D5C4]' },
  ACCEPTED:             { label: 'Store accepted',   tone: 'bg-[#EDF4EE] text-[#3F6B4C] border-[#CFE2D4]' },
  STORE_REJECTED:       { label: 'Store rejected',   tone: 'bg-[#FDEEEA] text-[#9A3412] border-[#F5D0C2]' },
  VERIFIED_NO_MOVEMENT: { label: 'Verified, nothing moved', tone: 'bg-amber-50 text-amber-800 border-amber-200' },
};

/**
 * What the line DID to stock. Spelled out in words rather than left as a code,
 * because "CENTRAL_DOWN" beside a vendor return and "CENTRAL_UP" beside an
 * internal one is the single fact that stops the two being added together.
 */
const EFFECT_META: Record<StockEffect, { label: string; tone: string; icon: React.ReactNode }> = {
  CENTRAL_DOWN: {
    label: 'Central stock DOWN',
    tone: 'bg-[#FDEEEA] text-[#9A3412] border-[#F5D0C2]',
    icon: <Truck className="w-3 h-3 shrink-0" />,
  },
  CENTRAL_UP: {
    label: 'Central stock UP',
    tone: 'bg-[#EDF4EE] text-[#3F6B4C] border-[#CFE2D4]',
    icon: <Building2 className="w-3 h-3 shrink-0" />,
  },
  DEPARTMENT_DOWN: {
    label: 'Department DOWN, central not credited',
    tone: 'bg-amber-50 text-amber-800 border-amber-200',
    icon: <Trash2 className="w-3 h-3 shrink-0" />,
  },
  NONE: {
    label: 'Nothing moved',
    tone: 'bg-[#F4EFE9] text-[#8B7355] border-[#E8D5C4]',
    icon: <CircleSlash className="w-3 h-3 shrink-0" />,
  },
};

const DISPOSITION_META: Record<ReturnDisposition, { label: string; tone: string }> = {
  reusable: { label: 'Reusable', tone: 'bg-[#EDF4EE] text-[#3F6B4C] border-[#CFE2D4]' },
  wastage:  { label: 'Wastage',  tone: 'bg-amber-50 text-amber-800 border-amber-200' },
  disposal: { label: 'Disposal', tone: 'bg-[#FDEEEA] text-[#9A3412] border-[#F5D0C2]' },
};

/* ══════════════════════════════════ format ═══════════════════════════════════ */

const fmtINR = (n: number) => '₹' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-IN');
const fmtNum = (n: number) => (Number(n) || 0).toLocaleString('en-IN');
/** Return quantities are routinely fractional (0.5 CTN, 2.25 kg) — never round them away. */
const fmtQty = (n: number) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

function shiftDays(ymd: string, days: number) {
  // Parsed as UTC midnight on purpose: the input is already an IST calendar date
  // from todayIST(), so plain day arithmetic on it is exact. A local Date here
  // would shift the window by a day on a non-IST browser.
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function firstOfMonth(iso: string) { return iso.slice(0, 8) + '01'; }
function fyStart(iso: string) {
  const [y, m] = iso.split('-').map(Number);
  return (m >= 4 ? y : y - 1) + '-04-01';
}

/** The clock off a stored timestamp, or '' when there is none. Never invented. */
const hhmm = (ts: string) => {
  const s = String(ts || '');
  return s.length >= 16 ? s.slice(11, 16) : '';
};

/** Rows painted before asking. The CSV always carries every row. */
const ROW_PAINT_CAP = 500;

/** An empty total, so the cards render even before the first response lands. */
const emptyTotal = (source: ReturnSource): SourceTotal => ({
  source, lines: 0, tickets: 0, moved_lines: 0, wastage_lines: 0, disposal_lines: 0,
  requested_qty: null, accepted_qty: null, qty_unit: '', qty_basis: 'purchase',
  requested_value: 0, accepted_value: 0,
  value_basis: source === 'VENDOR' ? 'credit_note' : 'memo',
  basis: '',
});

/* ════════════════════════════════ the page ═══════════════════════════════════ */

export default function ReturnReportPage() {
  const today = todayIST();
  // Default window: the last 30 days, resolved by the same function
  // purchase-log and issue-log use, so a reader cross-checking a return against
  // its receipt is looking at the same thirty days.
  const [from, setFrom] = useState(shiftDays(today, -29));
  const [to, setTo] = useState(today);

  const [source, setSource] = useState<SourceFilter>('all');
  const [departmentId, setDepartmentId] = useState('');
  const [materialId, setMaterialId] = useState('');
  const [vendor, setVendor] = useState('');
  const [vendorQ, setVendorQ] = useState('');
  const [retNumber, setRetNumber] = useState('');
  const [retNumberQ, setRetNumberQ] = useState('');
  const [status, setStatus] = useState('');
  const [disposition, setDisposition] = useState<DispositionFilter>('all');

  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);
  const [materials, setMaterials] = useState<MaterialLite[]>([]);
  const [materialsError, setMaterialsError] = useState(false);
  const [deptError, setDeptError] = useState(false);

  const [data, setData] = useState<ReturnLogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [paintAll, setPaintAll] = useState(false);

  // Filter option lists. Both are non-fatal: if either fails the report still
  // loads unfiltered, but say so rather than leave a picker that silently
  // finds nothing.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/inventory?scope=all', { cache: 'no-store' });
        if (!res.ok) { setMaterialsError(true); return; }
        const j = await res.json();
        setMaterials(Array.isArray(j.materials) ? j.materials : []);
      } catch { setMaterialsError(true); }
    })();
    (async () => {
      try {
        const res = await fetch('/api/departments', { cache: 'no-store' });
        if (!res.ok) { setDeptError(true); return; }
        const j = await res.json();
        setDepartments(Array.isArray(j.departments) ? j.departments : []);
      } catch { setDeptError(true); }
    })();
  }, []);

  // Vendor and return number are free text. Without debouncing, every keystroke
  // re-runs a multi-thousand-row query against a live production DB.
  useEffect(() => { const id = setTimeout(() => setVendorQ(vendor.trim()), 400); return () => clearTimeout(id); }, [vendor]);
  useEffect(() => { const id = setTimeout(() => setRetNumberQ(retNumber.trim()), 400); return () => clearTimeout(id); }, [retNumber]);

  const qs = useCallback((format: 'json' | 'csv') => {
    const p = new URLSearchParams({ from, to, source, disposition, format });
    if (departmentId) p.set('department_id', departmentId);
    if (materialId) p.set('material_id', materialId);
    if (vendorQ) p.set('vendor', vendorQ);
    if (retNumberQ) p.set('ret_number', retNumberQ);
    if (status) p.set('status', status);
    return p.toString();
  }, [from, to, source, disposition, departmentId, materialId, vendorQ, retNumberQ, status]);

  const load = useCallback(async () => {
    setLoading(true); setError(''); setPaintAll(false);
    try {
      const res = await fetch(`/api/reports/returns?${qs('json')}`, { cache: 'no-store' });
      // A failed load must never look like "no returns in this period" — clear
      // the rows and say why. An empty return report that is really an auth
      // failure is how a manager concludes nothing was ever sent back.
      if (res.status === 401) { setError('Sign in required.'); setData(null); return; }
      if (res.status === 403) { setError('Management only — you don’t have access to the return report.'); setData(null); return; }
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as any));
        setError(j?.error || `Failed to load the return report (HTTP ${res.status}).`); setData(null); return;
      }
      const j = (await res.json()) as ReturnLogResponse;
      setData({
        ...j,
        rows: (Array.isArray(j.rows) ? j.rows : []).map(r => ({ ...r, source: normSource(r.source) })),
        totals: {
          vendor: j.totals?.vendor || emptyTotal('VENDOR'),
          internal: j.totals?.internal || emptyTotal('INTERNAL'),
          by_source: Array.isArray(j.totals?.by_source) ? j.totals.by_source : [],
          lines: Number(j.totals?.lines || 0),
          basis: j.totals?.basis || '',
          sources_present: Array.isArray(j.totals?.sources_present) ? j.totals.sources_present : [],
        },
      });
    } catch { setError('Network error — please try again.'); setData(null); }
    finally { setLoading(false); }
  }, [qs]);

  useEffect(() => { load(); }, [load]);

  const download = async () => {
    setDownloading(true); setError('');
    try {
      // Same query string, same filters, same window — the CSV is a rendering
      // of the very result on screen, never a second differently-filtered one.
      const res = await fetch(`/api/reports/returns?${qs('csv')}`, { cache: 'no-store' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as any));
        setError(j?.error || (res.status === 403 ? 'Management only — download refused.' : `Download failed (HTTP ${res.status}).`));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `return-log-${from}_${to}.csv`; a.click();
      URL.revokeObjectURL(url);
    } catch { setError('Network error — download failed.'); }
    finally { setDownloading(false); }
  };

  const rows = data?.rows || [];

  /**
   * Requirement 78's "separate reports" — the write-off cut, derived from the
   * rows already on screen so it can never disagree with the table above it.
   * A line is in here when its disposition is not `reusable`; the Disposition
   * filter narrows the whole report (and the CSV) to one code when the owner
   * wants that cut on its own.
   */
  const writeOffRows = useMemo(
    () => rows.filter(r => r.disposition === 'wastage' || r.disposition === 'disposal'),
    [rows],
  );

  const paintLimit = paintAll ? rows.length : ROW_PAINT_CAP;
  const singleMaterial = !!materialId;
  const totals = data?.totals;
  const present = totals?.sources_present || [];
  const anyFilter = !!(
    source !== 'all' || disposition !== 'all' || departmentId || materialId
    || vendorQ || retNumberQ || status
  );

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E] overflow-x-hidden">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-5 sm:py-6 space-y-5">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">Reports</p>
            <h1 className="text-2xl sm:text-3xl font-bold mt-0.5 flex items-center gap-2">
              <Undo2 className="w-6 h-6 text-[#af4408] shrink-0" /> Return Report
            </h1>
            <p className="text-xs text-[#8B7355] mt-1">
              Vendor returns and internal department returns, every line, with who raised it, who approved it
              and whether any stock actually moved.
            </p>
          </div>
          <Link href="/reports/issue-log" className="text-sm font-medium text-[#af4408] hover:underline shrink-0">
            Traceability Log →
          </Link>
        </div>

        {/* ── THE TWO FACTS, stated where a reader hits them before any number.
            This is not decoration: without them a pending ticket reads as a
            movement, and the two sources read as parts of one figure. ── */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm p-4 space-y-2">
          <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide flex items-center gap-1.5">
            <ShieldAlert className="w-3.5 h-3.5 text-[#af4408]" /> Read these two sentences first
          </p>
          <p className="text-sm text-[#4A3728] leading-relaxed">
            <strong>Stock moves ONLY when the Store accepts a line.</strong> Raising a return moves nothing.
            The Department Head approving it moves nothing — an approved ticket means the goods are standing at
            the store counter and the books have not changed. A cancelled or rejected ticket, and any line the
            store rejected, leaves stock exactly where it was. Most rows on this report moved nothing at all;
            the <strong>Stock effect</strong> column is what says which ones did.
          </p>
          <p className="text-sm text-[#4A3728] leading-relaxed">
            <strong>A vendor return and an internal return have OPPOSITE effects on central stock.</strong>{' '}
            A <strong>vendor</strong> return sends goods back out of the building — central stock{' '}
            <strong>decreases</strong>, and the money is a credit note the vendor owes us, not a spend. An{' '}
            <strong>internal</strong> department return brings goods from a department back into the store —
            central stock <strong>increases</strong>, and the money is only a valued memo; nobody paid anybody.
            A line marked wastage or disposal is a third case: the department goes down and central is{' '}
            <strong>not</strong> credited, because unusable goods must never re-enter the sellable pool.
          </p>
        </div>

        {/* Filters */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm p-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="block"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">From</span>
              <input type="date" value={from} onChange={e => e.target.value && setFrom(e.target.value)}
                className="mt-1 block px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]" /></label>
            <label className="block"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">To</span>
              <input type="date" value={to} onChange={e => e.target.value && setTo(e.target.value)}
                className="mt-1 block px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]" /></label>

            <label className="block min-w-[210px]"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Kind of return</span>
              <select value={source} onChange={e => setSource(e.target.value as SourceFilter)}
                className="mt-1 block w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]">
                {SOURCE_FILTERS.map(o => <option key={o.k} value={o.k}>{o.label}</option>)}
              </select></label>

            <label className="block min-w-[160px]"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Department</span>
              <select value={departmentId} onChange={e => setDepartmentId(e.target.value)}
                className="mt-1 block w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]">
                <option value="">All departments</option>
                {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              {deptError && <p className="text-[10px] text-amber-700 mt-0.5">Department list didn’t load — showing all departments.</p>}
              {/* A department filter can only ever match internal tickets: a
                  vendor return has no department by construction. Said here so
                  an empty vendor card does not read as "no vendor returns". */}
              {departmentId && <p className="text-[10px] text-[#8B7355] mt-0.5">Vendor returns carry no department, so this filter shows internal returns only.</p>}</label>

            <div className="block min-w-[220px] flex-1"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Item</span>
              <div className="mt-1">
                <MaterialTypeahead materials={materials} value={materialId} onPick={setMaterialId} compact={false} showStock={false}
                  placeholder="All items — type name, SKU or category…" />
              </div>
              {materialsError && <p className="text-[10px] text-amber-700 mt-0.5">Item list didn’t load — showing all items.</p>}</div>

            {/* Free text, not a <select>: a vendor return may name a vendor that
                appears nowhere else in the current window, so a fixed list would
                hide it. Matched as "contains" by the server. */}
            <label className="block min-w-[150px]"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Vendor</span>
              <input value={vendor} onChange={e => setVendor(e.target.value)} placeholder="All vendors"
                className="mt-1 block w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]" /></label>

            <label className="block min-w-[150px]"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Return No</span>
              <input value={retNumber} onChange={e => setRetNumber(e.target.value)} placeholder="e.g. RET-2026-0042"
                className="mt-1 block w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]" /></label>

            <label className="block min-w-[230px]"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Ticket status</span>
              <select value={status} onChange={e => setStatus(e.target.value)}
                className="mt-1 block w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]">
                {STATUS_FILTERS.map(o => <option key={o.k} value={o.k}>{o.label}</option>)}
              </select></label>

            <label className="block min-w-[170px]"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Disposition</span>
              <select value={disposition} onChange={e => setDisposition(e.target.value as DispositionFilter)}
                className="mt-1 block w-full px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]">
                {DISPOSITION_FILTERS.map(o => <option key={o.k} value={o.k}>{o.label}</option>)}
              </select></label>

            <button onClick={download} disabled={downloading}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-60 text-white">
              {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} Download CSV
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {([
              ['Last 30 days', shiftDays(today, -29), today],
              ['This month', firstOfMonth(today), today],
              ['This FY', fyStart(today), today],
            ] as const).map(([label, f, t]) => (
              <button key={label} onClick={() => { setFrom(f); setTo(t); }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]">
                <CalendarDays className="w-3 h-3" />{label}
              </button>
            ))}
            {anyFilter && (
              <>
                <span className="mx-1 w-px h-5 bg-[#F0E4D6]" />
                <button
                  onClick={() => {
                    setSource('all'); setDisposition('all'); setDepartmentId('');
                    setMaterialId(''); setVendor(''); setRetNumber(''); setStatus('');
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border bg-white text-[#af4408] border-[#E8D5C4] hover:bg-[#FFF1E3]">
                  Clear filters
                </button>
              </>
            )}
          </div>
        </div>

        {error && <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">{error}</div>}

        {/* ══ PER-SOURCE TOTALS. TWO CARDS. NEVER A THIRD ONE COVERING BOTH. ══
            Each prints the server's own basis sentence VERBATIM underneath, and
            that sentence is the only thing stopping the two cards being read as
            two halves of one number. See the file header before touching this. */}
        {totals && (
          <div className="space-y-2">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {SOURCE_ORDER.map(src => {
                const t = src === 'VENDOR' ? totals.vendor : totals.internal;
                return (
                  <SourceCard
                    key={src}
                    source={src}
                    total={t}
                    singleMaterial={singleMaterial}
                    /* A source can be absent because the FILTERS exclude it
                       (source=vendor, or a department filter), not because
                       nothing happened. Without saying so, an empty card reads
                       as a clean sheet. */
                    excludedByFilter={present.length > 0 && !present.includes(src)}
                  />
                );
              })}
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900 flex gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <p>
                <strong>Do not add these two totals together.</strong> A vendor return takes stock OUT of the
                building and an internal return puts stock BACK into the store, so the two point in opposite
                directions on the same figure — and they carry different kinds of money, a claim on a vendor
                versus a memo valuation. There is deliberately no combined figure on this page or in the CSV.
                {totals.basis ? <> {totals.basis}</> : null}
              </p>
            </div>
          </div>
        )}

        {data?.truncated && (
          <div className="bg-[#af4408] text-white rounded-xl px-4 py-3 text-sm font-semibold flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>This list was TRUNCATED by the server — it is not the full report. The totals above are still
              correct (they are computed over the whole filtered set, not by adding the rows shown). Narrow the
              date range, pick an item or a department, or download the CSV.</span>
          </div>
        )}

        {/* ── The report ── */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow-sm p-4 sm:p-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
            <h2 className="text-sm font-bold flex items-center gap-2 min-w-0">
              <span className="text-[#af4408] shrink-0"><Undo2 className="w-4 h-4" /></span>
              <span className="truncate">Return lines — one row per item on a ticket</span>
              <span className="text-[11px] text-[#8B7355] font-normal shrink-0">({fmtNum(rows.length)} row{rows.length === 1 ? '' : 's'})</span>
            </h2>
            {loading && <span className="text-xs text-[#8B7355] inline-flex items-center gap-1.5 shrink-0"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</span>}
          </div>

          {/* The table scrolls inside THIS container. The page body must never
              scroll horizontally on a phone — hence overflow-x-hidden on the
              page shell and overflow-x-auto only here. */}
          <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
            <table className="w-full text-sm whitespace-nowrap">
              <ReturnTableHead />
              <tbody>
                {loading && rows.length === 0 ? (
                  <tr><td colSpan={11} className="py-6 text-center text-[#8B7355] animate-pulse">Loading return report…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={11} className="py-6 text-center text-[#8B7355]">
                    {error ? 'Not loaded — see the message above.' : 'No returns were raised in this range.'}
                  </td></tr>
                ) : (
                  rows.slice(0, paintLimit).map((r, i) => <ReturnRow key={rowKey(r, i)} r={r} />)
                )}
              </tbody>
            </table>
          </div>

          {rows.length > paintLimit && (
            <div className="pt-3 flex flex-wrap items-center gap-2 text-xs text-[#8B7355]">
              <Info className="w-3.5 h-3.5 shrink-0" />
              Showing the first {fmtNum(paintLimit)} of {fmtNum(rows.length)} loaded rows on screen — the CSV contains all of them.
              <button onClick={() => setPaintAll(true)} className="px-2.5 py-1 rounded-md border border-[#E8D5C4] text-[#af4408] hover:bg-[#FFF1E3] font-semibold">
                Show all {fmtNum(rows.length)}
              </button>
            </div>
          )}
        </div>

        {/* ══ REQUIREMENT 78 — DISPOSAL & WASTAGE, its own visually separate
            section. Only lines whose disposition is NOT `reusable`. Derived
            from the rows already loaded above, so the two can never disagree.
            These lines are the ones that never became "Returned Stock": an
            accepted write-off takes the DEPARTMENT down and does not credit
            central, because unusable goods must not re-enter the sellable pool. */}
        <div className="bg-white border-2 border-amber-200 rounded-xl shadow-sm p-4 sm:p-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
            <h2 className="text-sm font-bold flex items-center gap-2 min-w-0">
              <span className="text-amber-700 shrink-0"><PackageX className="w-4 h-4" /></span>
              <span className="truncate">Disposal &amp; Wastage — returned items marked unusable</span>
              <span className="text-[11px] text-[#8B7355] font-normal shrink-0">
                ({fmtNum(writeOffRows.length)} line{writeOffRows.length === 1 ? '' : 's'})
              </span>
            </h2>
          </div>
          <p className="text-[11px] text-[#6B5744] leading-relaxed mb-3">
            Lines marked <strong>wastage</strong> or <strong>disposal</strong> — never <em>reusable</em> ones. When the store
            accepts one of these, the <strong>department stock goes down and central stock is NOT credited</strong>: unusable
            goods never re-enter the sellable pool, so they never become returned stock at all. Until the store accepts,
            nothing has moved here either. Use the <strong>Disposition</strong> filter above to narrow the whole report — and
            the CSV — to just this cut.
          </p>

          <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
            <table className="w-full text-sm whitespace-nowrap">
              <ReturnTableHead />
              <tbody>
                {loading && writeOffRows.length === 0 ? (
                  <tr><td colSpan={11} className="py-5 text-center text-[#8B7355] animate-pulse">Loading…</td></tr>
                ) : writeOffRows.length === 0 ? (
                  <tr><td colSpan={11} className="py-5 text-center text-[#8B7355]">
                    {disposition === 'reusable'
                      ? 'The Disposition filter is set to “Reusable only”, so no write-off lines can appear here. Clear it to see them.'
                      : 'No returned items were marked wastage or disposal in this range.'}
                  </td></tr>
                ) : (
                  writeOffRows.slice(0, ROW_PAINT_CAP).map((r, i) => <ReturnRow key={`w-${rowKey(r, i)}`} r={r} />)
                )}
              </tbody>
            </table>
          </div>

          {writeOffRows.length > ROW_PAINT_CAP && (
            <p className="pt-3 text-xs text-[#8B7355] inline-flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 shrink-0" />
              Showing the first {fmtNum(ROW_PAINT_CAP)} of {fmtNum(writeOffRows.length)} write-off lines — the CSV contains all of them.
            </p>
          )}
        </div>

        {/* How to read it. Four of these sentences are the difference between
            the report being believed and the report being used to "prove"
            inventory that never moved. */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 text-[11px] text-[#6B5744] space-y-1.5 leading-relaxed">
          <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide">How to read this report</p>
          <p><strong>Stock moves only on Store Accept.</strong> The Qty column is what was <em>asked</em> to be returned;
            the Accepted column is what actually moved. They are different facts and are frequently different numbers.
            A row whose Stock effect says <em>Nothing moved</em> changed no stock scalar anywhere.</p>
          <p><strong>Vendor and internal returns pull in opposite directions.</strong> Vendor: out of the building, central
            stock down, money is a credit note the vendor owes. Internal: back into the store, central stock up, money is
            a valued memo. Never add a vendor figure to an internal one.</p>
          <p><strong>Quantities lead with the purchase unit</strong> (kg / L / BTL), the way the bill and the store shelf read.
            The recipe figure appears beneath as a declared “= 3,000 g” hint. Both come from the server; nothing on this page
            converts a unit.</p>
          <p><strong>PO No. and GRN No. are printed blank when they do not exist</strong>, never filled with a nearest match.
            Nine of the live GRNs were raised ad hoc with no purchase order behind them, and internal returns have no delivery
            to trace to at all — department stock is pooled, not lot-tracked. An empty cell is a fact.</p>
          <p><strong>Approved By is the Department Head or Manager</strong> who let the ticket reach the store — not the person
            who verified it there. Those are two separate acts by two separate people and they have their own columns.</p>
          <p><strong>Movement receipt missing</strong> flags a line that claims accepted quantity but has no ledger row to prove
            the grams moved. That is an integrity fault worth chasing, not a rounding artefact.</p>
          <p>No GST or cess is included in any figure on this page. A vendor value is a credit-note claim; an internal value is a
            memo valuation of goods that never left the company. Neither is a spend.</p>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════ sub-components ══════════════════════════════ */

function rowKey(r: ReturnLogRow, i: number) {
  return `${r.line_id || r.ret_number}-${r.material_id}-${i}`;
}

/**
 * ONE SOURCE's total. Its `basis` sentence comes off the wire and is printed
 * VERBATIM — it states this source's direction on central stock, and
 * paraphrasing it, shortening it or merging it with the other card's is how the
 * direction gets lost and the two cards start reading as one figure.
 */
function SourceCard({ source, total, singleMaterial, excludedByFilter }: {
  source: ReturnSource;
  total: SourceTotal;
  singleMaterial: boolean;
  excludedByFilter: boolean;
}) {
  const meta = SOURCE_META[source];
  const money = total.value_basis === 'credit_note' ? 'credit note claimed on the vendor' : 'valued memo — no money changed hands';

  return (
    <div className="rounded-xl border border-[#E8D5C4] bg-white shadow-sm p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide flex items-center gap-1.5 min-w-0">
          <span className="text-[#af4408] shrink-0">{meta.icon}</span><span className="truncate">{meta.label}</span>
        </p>
        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-bold tracking-wide shrink-0 ${meta.badge}`}>{meta.short}</span>
      </div>

      <p className="text-xl font-bold mt-1.5 text-[#2D1B0E]">
        {fmtNum(total.lines)} <span className="text-xs font-semibold text-[#8B7355]">line{total.lines === 1 ? '' : 's'}</span>
        <span className="text-xs font-normal text-[#8B7355]"> across {fmtNum(total.tickets)} ticket{total.tickets === 1 ? '' : 's'}</span>
      </p>

      {/* The movement count, not a share: the number that matters is how many
          lines the store has NOT yet accepted, because those moved nothing. */}
      <p className="text-[11px] text-[#6B5744] mt-1">
        <strong>{fmtNum(total.moved_lines)} of {fmtNum(total.lines)}</strong> lines actually moved stock — the Store Accept
        step is the only one that moves any.
      </p>

      {/* QUANTITY. Only a number when ONE item is selected: adding kg to L to
          BTL is not a quantity. When it is withheld the card SAYS SO — a blank
          cell beside a populated line count reads as "nothing came back". */}
      <p className="text-[11px] text-[#6B5744] mt-1.5">
        {singleMaterial && total.requested_qty !== null ? (
          <>
            Requested <strong>{fmtQty(total.requested_qty)} {total.qty_unit}</strong>
            {' · '}accepted <strong>{fmtQty(total.accepted_qty ?? 0)} {total.qty_unit}</strong>
            <span className="text-[#B8A48E]"> (purchase units)</span>
          </>
        ) : (
          <span className="text-[#B8A48E]">
            Quantity totals withheld — they are only meaningful with a single item selected. Pick one in the Item
            filter above. (Summing across items would add kg to litres to bottles.)
          </span>
        )}
      </p>

      <p className="text-[11px] text-[#6B5744] mt-1">
        Value requested <strong>{fmtINR(total.requested_value)}</strong> · accepted <strong>{fmtINR(total.accepted_value)}</strong>
        <span className="block text-[10px] text-[#B8A48E]">{money} — NOT a spend</span>
      </p>

      <p className="text-[11px] text-[#6B5744] mt-1">
        {fmtNum(total.wastage_lines)} wastage · {fmtNum(total.disposal_lines)} disposal
      </p>

      {excludedByFilter && (
        <p className="text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-2 whitespace-normal leading-snug">
          The current filters exclude this kind of return, so this card is empty because it was not asked for — not
          because no such return happened.
        </p>
      )}

      {/* VERBATIM from the server. Do not paraphrase, shorten or merge. */}
      <p className="text-[10px] text-[#8B7355] mt-2 whitespace-normal leading-snug border-t border-[#F0E4D6] pt-2">
        {total.basis || meta.direction}
      </p>
    </div>
  );
}

/** One heading row, shared by the main table and the Disposal & Wastage table
 *  so the two cannot drift into different column meanings. */
function ReturnTableHead() {
  return (
    <thead><tr className="text-left text-[11px] uppercase text-[#8B7355] border-b border-[#F0E4D6]">
      <th className="py-2 pr-3">Kind</th>
      <th className="py-2 px-3">Return No / date &amp; time</th>
      <th className="py-2 px-3">Item</th>
      <th className="py-2 px-3">PO / GRN</th>
      <th className="py-2 px-3">Dept / Vendor</th>
      <th className="py-2 px-3 text-right">Qty asked</th>
      <th className="py-2 px-3 text-right">Accepted</th>
      <th className="py-2 px-3">Reason</th>
      <th className="py-2 px-3">Status</th>
      <th className="py-2 px-3">Stock effect</th>
      <th className="py-2 pl-3 text-right">Value</th>
    </tr></thead>
  );
}

function ReturnRow({ r }: { r: ReturnLogRow }) {
  const line = LINE_STATUS_META[r.status] || { label: r.status || '—', tone: 'bg-[#F4EFE9] text-[#6B5744] border-[#E8D5C4]' };
  const effect = EFFECT_META[r.stock_effect] || EFFECT_META.NONE;
  const disp = DISPOSITION_META[r.disposition];
  const raisedTime = hhmm(r.raised_at);

  return (
    <tr className="border-b border-[#F7EEE3] last:border-0 align-top">
      <td className="py-2 pr-3">
        <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-bold tracking-wide ${SOURCE_META[r.source].badge}`}>
          {SOURCE_META[r.source].short}
        </span>
      </td>

      {/* Requirement 79: Date & Time. The clock is printed only when one was
          actually recorded — never invented from the calendar date. */}
      <td className="py-2 px-3 font-medium">
        {r.ret_number || '—'}
        <span className="block text-[10px] text-[#8B7355] font-normal">
          {r.date || '—'}{raisedTime ? ` · ${raisedTime}` : ''}
        </span>
      </td>

      <td className="py-2 px-3 font-medium whitespace-normal min-w-[170px]">
        {r.material || '—'}
        {r.sku && <span className="block text-[10px] text-[#8B7355] font-normal">{r.sku}</span>}
      </td>

      {/* Blank when there is none. A nearest match here would file a return
          against a purchase order the goods never came from. */}
      <td className="py-2 px-3 text-[11px] text-[#6B5744]">
        {r.po_no ? r.po_no : <span className="text-[#B8A48E]">no PO</span>}
        <span className="block text-[10px] text-[#8B7355]">{r.grn_no || <span className="text-[#B8A48E]">no GRN</span>}</span>
      </td>

      <td className="py-2 px-3 text-[#6B5744] whitespace-normal min-w-[130px]">
        {r.department || (r.source === 'VENDOR' ? <span className="text-[#B8A48E]">—</span> : '—')}
        {r.vendor && <span className="block text-[10px] text-[#8B7355]">{r.vendor}</span>}
      </td>

      {/* OWNER RULE: lead with the PURCHASE unit. Both figures come off the wire
          already converted through pack-units; nothing is derived here. */}
      <td className="py-2 px-3 text-right tabular-nums">
        <span className="font-semibold">{fmtQty(r.purchase_qty)} <span className="text-[11px] text-[#8B7355] font-normal">{r.purchase_unit || r.unit}</span></span>
        <span className="block text-[10px] text-[#B8A48E]">purchase units</span>
        {!!r.recipe_unit && (
          <span className="block text-[10px] text-[#8B7355]">= {fmtQty(r.recipe_qty)} {r.recipe_unit}</span>
        )}
      </td>

      {/* What the store ACCEPTED — the grams that actually moved. Zero here on
          every row the store has not verified, which is most of them. */}
      <td className="py-2 px-3 text-right tabular-nums">
        {r.stock_moved ? (
          <>
            <span className="font-semibold">{fmtQty(r.accepted_purchase_qty)} <span className="text-[11px] text-[#8B7355] font-normal">{r.purchase_unit || r.unit}</span></span>
            <span className="block text-[10px] text-[#B8A48E]">moved</span>
          </>
        ) : (
          <span className="text-[#B8A48E]">not accepted</span>
        )}
        {r.receipt_missing && (
          <span className="inline-flex items-start gap-1 text-[10px] text-[#9A3412] bg-[#FDEEEA] border border-[#F5D0C2] rounded px-1 py-0.5 mt-1 whitespace-normal max-w-[180px]">
            <AlertTriangle className="w-3 h-3 shrink-0 mt-[1px]" />movement receipt missing
          </span>
        )}
      </td>

      <td className="py-2 px-3 whitespace-normal min-w-[170px] text-[#6B5744]">
        <span className="text-[11px]">{r.reason || <span className="text-[#B8A48E]">—</span>}</span>
        {disp && r.disposition !== 'reusable' && (
          <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-bold tracking-wide mt-1 ${disp.tone}`}>{disp.label}</span>
        )}
        {/* Requirement 74 makes the store state a reason on every rejection.
            It belongs beside the reason it overrode. */}
        {r.store_reject_reason && (
          <span className="block text-[10px] text-[#9A3412] mt-1">Store rejected: {r.store_reject_reason}</span>
        )}
      </td>

      {/* The LINE's outcome, plus who acted at each of the two separate steps. */}
      <td className="py-2 px-3 whitespace-normal min-w-[160px]">
        <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-bold tracking-wide ${line.tone}`}>{line.label}</span>
        <span className="block text-[10px] text-[#8B7355] mt-1">Raised by {r.raised_by || '—'}</span>
        <span className="block text-[10px] text-[#8B7355]">
          {r.approved_by ? <>Approved by {r.approved_by}{r.approved_at ? ` · ${r.approved_at.slice(0, 10)}` : ''}</> : 'Not yet approved'}
        </span>
        <span className="block text-[10px] text-[#8B7355]">
          {r.verified_by ? <>Store: {r.verified_by}{r.verified_at ? ` · ${r.verified_at.slice(0, 10)}` : ''}</> : 'Not yet at the store'}
        </span>
      </td>

      {/* The column that stops a pending ticket being read as a movement. */}
      <td className="py-2 px-3 whitespace-normal min-w-[150px]">
        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-bold tracking-wide ${effect.tone}`}>
          {effect.icon}{effect.label}
        </span>
        {r.stock_effect === 'NONE' && (
          <span className="block text-[10px] text-[#B8A48E] mt-0.5">stock moves only on Store Accept</span>
        )}
      </td>

      {/* rate-basis: purchase — `rate` is Rs per PURCHASE unit and the values
          were multiplied out against a PURCHASE-unit quantity by the server.
          No rate meets a quantity on this page; nothing here is multiplied. */}
      <td className="py-2 pl-3 text-right tabular-nums">
        {r.requested_value == null ? <span className="text-[#B8A48E]">—</span> : (
          <>
            <span className="font-semibold">{fmtINR(r.requested_value)}</span>
            <span className="block text-[10px] text-[#B8A48E]">
              {r.value_basis === 'credit_note' ? 'credit note claim' : r.value_basis === 'memo' ? 'valued memo' : ''}
            </span>
            {r.stock_moved && r.accepted_value != null && (
              <span className="block text-[10px] text-[#6B5744]">accepted {fmtINR(r.accepted_value)}</span>
            )}
            {r.rate != null && (
              <span className="inline-flex items-center gap-1 text-[10px] text-[#8B7355] mt-0.5">
                <Receipt className="w-3 h-3 shrink-0 text-[#C9B39C]" />
                {fmtINR(r.rate)}/{r.purchase_unit || 'unit'}
              </span>
            )}
          </>
        )}
      </td>
    </tr>
  );
}
