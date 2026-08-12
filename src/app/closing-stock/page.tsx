'use client';

/**
 * Closing-stock by Storage Location — Phase 1 §6 EOD ritual.
 * Pick a physical area (Walk-in chiller, Bar back-bar, Dry store rack 3…),
 * see only the items present there, type counts inline, save the whole
 * location in one click. Lets multiple staff count parallel locations.
 *
 * Set the storage_location field on each material via Inventory → Edit.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  MapPin,
  Loader2,
  Save,
  ChevronLeft,
  Package,
  CheckCircle2,
  ClipboardCheck,
  X,
  Search,
  AlertTriangle,
  TrendingDown,
  TrendingUp,
  Minus,
  CheckCircle,
  AlertCircle,
  Download,
  Upload,
  Layers,
  Plus,
  ListChecks,
} from 'lucide-react';
import Papa from 'papaparse';
import { api } from '@/lib/api';
import { csvQty, fmtQtyNum, packFactor, toPurchaseQty } from '@/lib/pack-units';
import { todayIST } from '@/lib/format-date';
import TabScroller from '@/components/TabScroller';

const fmt = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');
const today = () => new Date().toISOString().slice(0, 10);
/** The small grey recipe hint printed under a purchase-unit figure (house
 *  style). Null when the material has no real pack conversion, so a pack-1
 *  item never gets a second line repeating the same number. */
const hintLine = (recipeQty: number, m: { unit?: string | null; purchase_unit?: string | null; pack_size?: number | null }) =>
  packFactor(m) > 1 ? `= ${fmtQtyNum(recipeQty)} ${m.unit || ''}`.trim() : null;

/* ══════════════════════════════════════════════════════════════════════════
 * VALUATION DISPLAY (req 2/3/4) — rates and values are RESOLVED AND STORED BY
 * THE SERVER (src/lib/closing-valuation.ts, persisted on closing_stock.
 * rate_per_purchase_unit / rate_source / total_value and closing_stock_semi.
 * rate / total_value). This file only PRINTS them.
 *
 * Nothing here derives a rate. raw_materials.last_purchase_price is stored in
 * mixed bases on live data (MALA STRAWBERRY CRUSH 5 LTR holds 0.13 against a
 * true ₹674.10/BTL — a 5,000x error), so the browser must never read it and
 * must never re-multiply a historical row by today's price: a count is a dated
 * record and shows the rate it was valued at.
 * ══════════════════════════════════════════════════════════════════════════ */

/** ₹ with paise. Rates are per PURCHASE unit and are often small (₹0.20/BTL). */
const fmtRate = (v: number) =>
  '₹' + Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * ₹ for the valuation columns, always to paise. Deliberately NOT formatCurrency:
 * that one drops a trailing zero (₹2,022.3), which reads wrong sitting next to a
 * ₹674.10 rate in the same row. formatCurrency is left exactly as it is so the
 * existing variance columns are untouched.
 */
const fmtMoney = (v: number) =>
  '₹' + Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * True when the server resolved NO valuation basis (rate_source 'none'), or the
 * row predates the valuation columns. 194 live materials have neither a priced
 * purchase nor an average cost — they get an em-dash, never a confident ₹0.
 */
const noBasis = (source?: string | null, rate?: number | null) =>
  source === 'none' || source == null || rate == null || !(Number(rate) > 0);

/** "last purchase 12 Jul" / "avg cost" — where the stored rate came from. */
function rateSourceLabel(source?: string | null, asOf?: string | null): string | null {
  if (source === 'last_purchase') {
    const d = asOf ? new Date(asOf) : null;
    return d && !isNaN(d.getTime())
      ? `last purchase ${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`
      : 'last purchase';
  }
  if (source === 'average_cost') return 'avg cost';
  return null;
}

/** The em-dash a missing basis prints — same everywhere, with the reason. */
const NoBasisDash = ({ what = 'valuation' }: { what?: string }) => (
  <span className="text-[#B8A590]" title={`No ${what} basis — no priced purchase and no average cost on record. Shown as an em-dash rather than a false ₹0.`}>
    —
  </span>
);

/**
 * The em-dash a CROSS-MATERIAL total prints. Rupees add up across materials;
 * quantities do not — 2 BTL + 3 kg + 400 g is not a number. Money totals stay,
 * quantity and rate totals become this.
 */
const CrossDash = ({ what }: { what: string }) => (
  <span className="text-[#B8A590]" title={`A ${what} cannot be summed across materials — they are in different units. Only the rupee total adds up.`}>
    —
  </span>
);

/**
 * Rate cell. `purchaseUnit` is deliberately NOT called `unit`: this rate is ₹
 * per PURCHASE unit, so it pairs with the purchase quantity beside it and must
 * never be printed against a recipe figure.
 */
function RateCell({ rate, source, asOf, purchaseUnit, stored }: {
  rate?: number | null; source?: string | null; asOf?: string | null;
  purchaseUnit?: string | null;
  /** API `rate_is_stored`. false = the row predates the valuation columns and
   *  the server derived this rate on READ, so it is today's price, not the
   *  count-day price. Marked, because an estimate must not pass as history. */
  stored?: boolean;
}) {
  if (noBasis(source, rate)) return <NoBasisDash what="price" />;
  const label = rateSourceLabel(source, asOf);
  return (
    <span className="font-mono">
      {fmtRate(Number(rate))}<span className="text-[10px] text-[#8B7355]">/{purchaseUnit || ''}</span>
      {label && (
        <span className="block text-[9px] font-sans text-[#B8A590]">
          {label}
          {stored === false && (
            <span title="This count was saved before closing stock was valued, so no rate was stored with it. Shown here at today's price — an estimate, not the count-day rate.">
              {' '}· est.
            </span>
          )}
        </span>
      )}
    </span>
  );
}

/** Quantity × Rate, as stored by the server. Em-dash when there was no basis. */
function ValueCell({ value, source, rate }: { value?: number | null; source?: string | null; rate?: number | null }) {
  if (noBasis(source, rate) || value == null) return <NoBasisDash />;
  return <span className="font-mono">{fmtMoney(Number(value))}</span>;
}

/** The row's rate whichever sheet it came from: raw materials are priced per
 *  PURCHASE unit, sub-recipes per YIELD unit. */
const rowRate = (r: any) => r?.rate_per_purchase_unit ?? r?.rate_per_unit;

/** Sum of the server's per-item rupee values. Money adds up across materials;
 *  quantities do not — every cross-material QUANTITY total prints an em-dash. */
const sumValue = (rows: any[]) =>
  rows.reduce((s, r) => s + (noBasis(r?.rate_source, rowRate(r)) ? 0 : Number(r?.total_value) || 0), 0);

/** How many rows on a sheet could not be valued — printed so a total is never
 *  mistaken for the whole sheet. */
const unvaluedCount = (rows: any[]) =>
  rows.filter(r => noBasis(r?.rate_source, rowRate(r))).length;

/** A sub-recipe as the count sheet needs it (id, name, and its yield basis). */
interface SubRecipeRow {
  id: string; name: string; category?: string;
  yield_unit: string; cost_per_unit?: number;
}

/** CSV item TYPE — the column that makes a re-upload unambiguous. A sub-recipe
 *  and a raw material may share a name ("Green Chutney"); the parser must never
 *  have to guess which table a row belongs to. */
const CSV_TYPE_RAW = 'RAW';
const CSV_TYPE_SEMI = 'SEMI';

/* ------------------------------------------------------------------ */
/* Closing-stock UPDATE modal helpers (moved from Raw Materials page)  */
/* ------------------------------------------------------------------ */

// Kept in sync with the Raw Materials page — drives category chips/labels in
// the Record Closing Stock modal below.
const CATEGORIES = [
  'veg',
  'non-veg',
  'bar',
  'grocery',
  'dairy',
  'bakery',
  'spices',
  'beverages',
  'packaging',
  'other',
] as const;

const CATEGORY_COLORS: Record<string, { bg: string; text: string }> = {
  veg: { bg: 'bg-green-500/15', text: 'text-green-400' },
  'non-veg': { bg: 'bg-red-500/15', text: 'text-red-400' },
  bar: { bg: 'bg-purple-500/15', text: 'text-purple-400' },
  grocery: { bg: 'bg-amber-500/15', text: 'text-amber-400' },
  dairy: { bg: 'bg-blue-500/15', text: 'text-[#af4408]' },
  bakery: { bg: 'bg-orange-500/15', text: 'text-orange-400' },
  spices: { bg: 'bg-yellow-500/15', text: 'text-yellow-400' },
  beverages: { bg: 'bg-cyan-500/15', text: 'text-cyan-400' },
  packaging: { bg: 'bg-slate-500/15', text: 'text-[#8B7355]' },
  other: { bg: 'bg-gray-500/15', text: 'text-gray-400' },
};

function formatCurrency(value: number): string {
  return '₹' + value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function categoryLabel(cat: string): string {
  return cat
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('-');
}

interface LocSummary { location: string; items: number; counted_today: number; low_stock: number; }
interface Item {
  id: string; sku?: string; name: string; unit: string; purchase_unit?: string; pack_size?: number; case_size?: number;
  current_stock: number | null; average_price: number; reorder_level?: number;   // system stock — null for non-admins (blind count)
  super_category?: string; category?: string; closing_cadence?: string; shelf_life_days?: number;
  today_count: number | null; today_variance: number | null; today_by?: string;
}

/* ══════════════════════════════════════════════════════════════════════════
 * REQUIREMENT 3 — THE ESCAPE HATCH
 * A department's sheet lists what it has ever requisitioned. The first time a
 * section physically holds something new, that list cannot know about it yet —
 * and a counter who cannot record real stock writes it on paper instead, which
 * is how stock goes missing. So every dept-scoped counting surface carries an
 * explicit "add an item not on this list".
 *
 * Search runs on the server (/api/closing-stock?dept_items=1&search=…), which
 * returns only CENTRAL materials this department does not already have — and
 * blinds current_stock for non-admins exactly like every other closing surface,
 * so the escape hatch can never become a way to read the system figure.
 * Once the added item is counted and saved it joins the department's set for
 * good (the closing_stock arm of DEPT_REQUESTED_ITEM_SQL).
 * ══════════════════════════════════════════════════════════════════════════ */
function AddOffListItem({ deptId, deptName, existingIds, onAdd, compact }: {
  deptId: string;
  deptName: string;
  existingIds: Set<string>;
  onAdd: (row: any) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  // Reset whenever the department changes — one dept's candidates are
  // meaningless on another's sheet.
  useEffect(() => { setOpen(false); setQ(''); setRows([]); setErr(''); }, [deptId]);

  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (term.length < 2) { setRows([]); setErr(''); setLoading(false); return; }
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ dept_items: '1', department_id: deptId, search: term });
      fetch(`/api/closing-stock?${qs}`)
        .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then(j => { if (live) { setRows(j?.candidates || []); setErr(''); } })
        .catch(() => { if (live) { setRows([]); setErr('Could not search the catalogue. Try again, or record the count on the Store / Overall sheet.'); } })
        .finally(() => { if (live) setLoading(false); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q, open, deptId]);

  const shown = rows.filter(r => !existingIds.has(String(r.id)));

  return (
    <div className={compact ? '' : 'w-full'}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-dashed border-[#af4408] text-[#af4408] hover:bg-[#FFF1E3] text-xs font-medium transition-colors"
      >
        <Plus className="w-3.5 h-3.5" />
        {open ? 'Close' : 'Add an item not on this list'}
      </button>
      {open && (
        <div className="mt-2 rounded-xl border border-[#E8D5C4] bg-[#FFFDF9] p-3 space-y-2">
          <p className="text-[11px] text-[#6B5744]">
            {deptName} is holding something it has never requisitioned? Find it here and it joins this
            sheet. Once you save a count against it, it stays on {deptName}&apos;s list for good.
          </p>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
            <input
              type="text"
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search the central catalogue by name or SKU…"
              className="w-full pl-10 pr-3 py-2 bg-white border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] placeholder-[#8B7355] focus:outline-none focus:ring-2 focus:ring-[#af4408]"
            />
          </div>
          {err && <p className="text-[11px] text-red-700">{err}</p>}
          {loading && (
            <p className="text-[11px] text-[#8B7355] flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" /> Searching…
            </p>
          )}
          {!loading && !err && q.trim().length >= 2 && shown.length === 0 && (
            <p className="text-[11px] text-[#8B7355]">
              Nothing matching &ldquo;{q.trim()}&rdquo; outside this department&apos;s list. It may already be on
              the sheet above, or it is liquor — count that in its own store&apos;s closing.
            </p>
          )}
          {shown.length > 0 && (
            <ul className="max-h-56 overflow-y-auto divide-y divide-[#E8D5C4]/60 rounded-lg border border-[#E8D5C4] bg-white">
              {shown.map(r => (
                <li key={r.id} className="flex items-center gap-2 px-3 py-1.5">
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs font-medium text-[#2D1B0E] truncate">{r.name}</span>
                    <span className="block text-[10px] text-[#8B7355]">
                      {categoryLabel(r.category || 'other')}
                      {r.sku ? ` · ${r.sku}` : ''} · counted in {r.purchase_unit || r.unit}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => { onAdd(r); setQ(''); setRows([]); }}
                    className="px-2.5 py-1 rounded bg-[#af4408] hover:bg-[#933807] text-white text-[11px] font-medium"
                  >
                    Add
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default function ClosingStockByLocationPage() {
  // Role gate — only admins see the "adjust system stock to match" shortcut.
  // Store managers would otherwise just click it without a physical recount,
  // which defeats the purpose of the closing-stock workflow.
  const [meRole, setMeRole] = useState<string | null>(null);
  // Full viewer so we can scope closing stock per-department. A plain department
  // user (staff, not head-chef / store-manager) only counts their OWN department;
  // Admin / Manager / HOD (head-chef) / Store Manager may pick any department and
  // see the per-area rollup.
  const [me, setMe] = useState<any>(null);
  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => { setMe(d?.user || null); setMeRole(d?.user?.role || null); }).catch(() => {});
  }, []);
  const isAdmin = meRole === 'admin';
  // Can this viewer see/update ALL departments (and the rollup)?
  const canSeeAllDepts = !!me && (me.role === 'admin' || me.role === 'manager' || !!me.is_head_chef || !!me.is_store_manager);
  // The department a plain user is locked to (their own). null = store/overall.
  const ownDeptId: string | null = me?.department_id || null;
  // Explicitly-granted extra departments (Users → Page Access & Department
  // Visibility). A staff-tier user with a non-empty list may pick among THOSE
  // departments (plus their own) — no tier change needed to count e.g. Bar.
  const visibleDeptIds = useMemo<string[]>(() => {
    if (!me?.visible_department_ids) return [];
    try {
      const a = JSON.parse(me.visible_department_ids);
      return Array.isArray(a) ? a.map(String).filter(Boolean) : [];
    } catch { return []; }
  }, [me]);
  // Does this viewer get a department picker at all (full list or granted subset)?
  const hasDeptChoice = canSeeAllDepts || visibleDeptIds.length > 0;

  // Departments list (picker options + own-dept name for the pinned banner) +
  // the currently-selected dept. '' means store / overall (no owning department).
  const [departments, setDepartments] = useState<any[]>([]);
  const [selectedDept, setSelectedDept] = useState<string>('');
  useEffect(() => {
    if (!me) return;
    // Non-all-dept users start on (or stay pinned to) their own department.
    if (!canSeeAllDepts) setSelectedDept(ownDeptId || '');
    fetch('/api/departments').then(r => r.json()).then(d => {
      setDepartments((d?.departments || []).filter((x: any) => x.is_active));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);
  // Departments this viewer may record for: the full list for Admin / Manager /
  // HOD / Store Manager; only the granted subset (plus own dept) otherwise.
  const pickableDepts = useMemo(() => {
    if (canSeeAllDepts) return departments;
    const allow = new Set<string>([...visibleDeptIds, ...(ownDeptId ? [ownDeptId] : [])]);
    return departments.filter((d: any) => allow.has(d.id));
  }, [departments, canSeeAllDepts, visibleDeptIds, ownDeptId]);
  // The department_id sent on POST to scope saved counts. Pinned users → own dept.
  const activeDeptId: string = hasDeptChoice ? selectedDept : (ownDeptId || '');
  // Non-privileged users only count their department's ITEM SET (materials
  // issued to or already counted by the dept — /api/department-stock rows).
  // Intersects the Record modal list + CSV template below. null = no
  // restriction (privileged viewers, or the fetch failed → old behaviour;
  // the by-location API is server-scoped regardless).
  const [deptItemIds, setDeptItemIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!me || canSeeAllDepts || !activeDeptId) { setDeptItemIds(null); return; }
    let live = true;
    fetch(`/api/department-stock?department_id=${encodeURIComponent(activeDeptId)}`)
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (!live) return;
        setDeptItemIds(j ? new Set<string>((j.rows || []).map((r: any) => String(r.material_id))) : null);
      })
      .catch(() => { if (live) setDeptItemIds(null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, canSeeAllDepts, activeDeptId]);

  /* ══════════════════════════════════════════════════════════════════════════
   * REQUIREMENT 4 — A DEPARTMENT COUNTS ONLY THE ITEMS IT ACTUALLY USES
   * ══════════════════════════════════════════════════════════════════════════
   * Owner: "If a department requests the 40 items till now, only those items to
   * be shown to the departments for their closing stock updating… once an item
   * is requested by a department they will have that stock and it will be
   * maximum their regular stock, so it may be 1 year also."
   *
   * EVER-REQUESTED, no recency window. The set is derived on the server from
   * requisition_items → requisitions (rejected lines excluded) — see
   * src/lib/dept-requested-items.ts — and returned as ready-to-render rows so
   * an item the department requested but whose CATEGORY is outside the dept
   * whitelist still reaches the sheet. Those rows arrive with current_stock
   * blinded for non-admins, same as every other closing surface.
   *
   * This applies to EVERY tier, admins included: the question is "what does
   * this department count?", not "what is this user allowed to see". Store /
   * Overall ('') is untouched — the full catalogue, exactly as before.
   *
   * FAIL-OPEN, LOUDLY. If the scope call fails we fall back to the previous
   * behaviour (full category-filtered list) and say so on screen, because a
   * counter facing an empty sheet writes numbers on paper. Hiding rows is a
   * convenience; losing a count is money.
   */
  const [deptRequested, setDeptRequested] = useState<{ deptId: string; rows: any[]; count: number } | null>(null);
  const [deptScopeLoading, setDeptScopeLoading] = useState(false);
  const [deptScopeError, setDeptScopeError] = useState(false);
  /* Items a counter pulled in through the escape hatch, keyed by department so
     switching departments never carries one dept's addition onto another's
     sheet. Session-only: saving a count is what makes an addition permanent. */
  const [extraByDept, setExtraByDept] = useState<Record<string, any[]>>({});
  useEffect(() => {
    if (!me) return;
    if (!activeDeptId) { setDeptRequested(null); setDeptScopeError(false); setDeptScopeLoading(false); return; }
    let live = true;
    setDeptScopeLoading(true);
    setDeptScopeError(false);
    const qs = new URLSearchParams({ dept_items: '1', department_id: activeDeptId });
    fetch(`/api/closing-stock?${qs}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(j => {
        if (!live) return;
        if (j?.scoped) setDeptRequested({ deptId: activeDeptId, rows: j.items || [], count: Number(j.count) || 0 });
        else { setDeptRequested(null); setDeptScopeError(true); }
      })
      .catch(() => { if (live) { setDeptRequested(null); setDeptScopeError(true); } })
      .finally(() => { if (live) setDeptScopeLoading(false); });
    return () => { live = false; };
  }, [me, activeDeptId]);

  /** Is the ever-requested scope in force right now (loaded, for THIS dept)? */
  const deptScopeActive = !!activeDeptId && !!deptRequested && deptRequested.deptId === activeDeptId;
  const extraRows = activeDeptId ? (extraByDept[activeDeptId] || []) : [];
  const addExtraRow = (row: any) => {
    if (!activeDeptId) return;
    setExtraByDept(prev => {
      const cur = prev[activeDeptId] || [];
      if (cur.some(r => String(r.id) === String(row.id))) return prev;
      return { ...prev, [activeDeptId]: [...cur, row] };
    });
  };

  // Category whitelist (lowercased) of the ACTIVE department, resolved to its
  // MAIN department — sub-depts inherit the main's material_categories, so walk
  // parent_id via the departments payload. null = no filter: Store/Overall ('')
  // or a department with no categories configured.
  const deptCategorySet = useMemo<Set<string> | null>(() => {
    if (!activeDeptId || departments.length === 0) return null;
    const byId = new Map(departments.map((d: any) => [String(d.id), d]));
    let d: any = byId.get(activeDeptId);
    if (!d) return null;
    if (d.parent_id && byId.get(String(d.parent_id))) d = byId.get(String(d.parent_id));
    if (!d.material_categories) return null;
    try {
      const arr = JSON.parse(d.material_categories);
      if (!Array.isArray(arr) || arr.length === 0) return null;
      return new Set<string>(arr.map((c: any) => String(c).trim().toLowerCase()).filter(Boolean));
    } catch { return null; }
  }, [activeDeptId, departments]);
  const [date, setDate] = useState(today());
  const [locations, setLocations] = useState<LocSummary[]>([]);
  const [totals, setTotals] = useState({ locations: 0, items: 0, counted: 0 });
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [entries, setEntries] = useState<Record<string, string>>({});
  // Three count levels so liquor can be entered the way it's physically counted:
  //   cases   → full outer cases (case_size bottles each)
  //   entries → individual bottles / purchase units (pack_size recipe-units each)
  //   loose   → loose / open recipe units (e.g. 450 ml left in an open bottle)
  // e.g. whisky 2 cases + 9 bottles + 450 ml = 2×12×750 + 9×750 + 450 = 25,200 ml.
  const [cases, setCases] = useState<Record<string, string>>({});
  const [loose, setLoose] = useState<Record<string, string>>({});
  const [adjustStock, setAdjustStock] = useState(false);
  const [saving, setSaving] = useState(false);
  /* Save flash on the per-area count screen. `tone` is what the server DID, not
     how the save went: 'applied' means stock has already moved (Adjust system
     stock ticked, central rows), 'ok' means the counts are recorded and any
     variance is waiting on an approver, 'warn' means the server reported
     something it could not do. Those three must not look identical — the banner
     used to be emerald in every case, so a parked count read as a done deal. */
  const [savedFlash, setSavedFlash] = useState<{ text: string; tone: 'ok' | 'applied' | 'warn' } | null>(null);
  const [filterUncountedOnly, setFilterUncountedOnly] = useState(false);
  // Category filter — narrows the detail-view item list to one super_category
  // (or category fallback). Empty string = all categories. Item search box
  // filters within the selected category.
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [itemSearch, setItemSearch] = useState<string>('');

  /* ---- Closing-stock UPDATE modal (moved from Raw Materials page) ---- */
  // Full raw-material list — only fetched when the modal opens so the
  // location-count workflow above stays lightweight.
  const [materials, setMaterials] = useState<any[]>([]);
  const [closingStockOpen, setClosingStockOpen] = useState(false);
  const [closingDate, setClosingDate] = useState(new Date().toISOString().split('T')[0]);
  /* DEEP LINK from the Closing Overview board: /closing-stock?date=&location=&department_id=
     Seeded once on mount — without this every "Record" link on that board landed
     on today's page with no area or department selected, which reads as a dead
     link. Applied only when the param is present, so a plain visit is unchanged. */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const q = new URLSearchParams(window.location.search);
    const d = q.get('date');
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) { setDate(d); setClosingDate(d); }
    const dept = q.get('department_id');
    if (dept && dept !== '__store__') setSelectedDept(dept);
    const loc = q.get('location');
    if (loc) setPendingLocation(loc === '__unassigned__' ? '— Unassigned —' : loc);
  }, []);
  // Applied once the location list has loaded (the drill-in needs the list).
  const [pendingLocation, setPendingLocation] = useState<string | null>(null);
  const [closingItems, setClosingItems] = useState<Record<string, { physical_stock: string; notes: string }>>({});
  /* SEMI-FINISHED (req 1) — the 68 sub_recipes the kitchen physically holds at
     close (Mint Chutney, GG Paste, Aioli…). They are NOT raw materials, so they
     never appeared on this sheet or in the CSV template and simply could not be
     counted. Counted in their OWN yield_unit; no pack factor applies. */
  const [subRecipes, setSubRecipes] = useState<SubRecipeRow[]>([]);
  const [closingSemi, setClosingSemi] = useState<Record<string, { physical_stock: string; notes: string }>>({});
  const [closingSearch, setClosingSearch] = useState('');
  const [closingCategory, setClosingCategory] = useState('');
  const [adjustStockModal, setAdjustStockModal] = useState(false);
  const [closingSubmitting, setClosingSubmitting] = useState(false);
  /* `pending` / `applied` split the saved counts by WHAT HAPPENED TO STOCK — the
     whole point of the Adjust-system-stock tick. `applied` rows had their variance
     approved on the spot and stock HAS already moved; `pending` rows are parked in
     the variance queue for an admin to clear later. Both optional: the early-exit
     error paths below set neither, and only the raw-material leg reports them (a
     semi-finished count never moves raw stock). */
  const [closingResult, setClosingResult] = useState<{ success: number; errors: string[]; semi?: number; pending?: number; applied?: number } | null>(null);
  /* The saved sheet, re-read from the server after a save/upload so the rate and
     Quantity × Rate shown are exactly the ones the server RESOLVED AND STORED
     (req 2/3) — never a browser-side recomputation. */
  const [valued, setValued] = useState<{
    date: string; items: any[]; semi: any[]; total: number; priced: boolean;
  } | null>(null);
  const [closingHistory, setClosingHistory] = useState<any[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyDate, setHistoryDate] = useState<string | null>(null);
  const [historyItems, setHistoryItems] = useState<any[]>([]);
  const [historySemi, setHistorySemi] = useState<any[]>([]);
  const [historySummary, setHistorySummary] = useState<any>(null);
  // Per-area rollup (admin/HOD only) — each area's overall physical closing value
  // for the selected date. Sourced from summary.by_area on /api/closing-stock.
  const [byArea, setByArea] = useState<any[]>([]);
  const AREA_LABELS: Record<string, string> = {
    kitchen: 'Kitchen', bar: 'Bar', store: 'Store', service: 'Service / Ops', other: 'Other', __store__: 'Store / Overall',
  };

  // Name of the department a pinned user records for ('Store/Overall' when none).
  const ownDeptName = departments.find((d: any) => d.id === ownDeptId)?.name
    || (ownDeptId ? 'your department' : 'Store/Overall');
  // Amber info banner shown wherever the department picker is HIDDEN — surfaces
  // the user's EFFECTIVE tier (named roles can silently downgrade a "manager" to
  // staff) and how an admin can unlock other departments. Rendered in both the
  // top-level department area and the Record Closing Stock modal.
  const tierBanner = (me && !hasDeptChoice) ? (
    <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-xs text-amber-800">
      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <span>
        Recording for <strong>{ownDeptName}</strong>. Your access tier is {`'${me.role}'`}
        {me.role_name ? <> from role {`'${me.role_name}'`}</> : null} — Manager tier (or HOD/Store
        Manager) unlocks recording for other departments like Bar. An admin can change this in Users.
      </span>
    </div>
  ) : null;

  /* Modal item list scoped to the ACTIVE department's category whitelist.
     Staff (no dept choice) fetch WITHOUT scope=all, so the server whitelist
     already returns exactly their main dept's items. Privileged viewers keep
     the scope=all fetch and are client-filtered here by the SELECTED dept's
     category set — re-filters live when the dropdown changes. Store/Overall
     ('') or a dept with no configured categories → no filter (full list). */
  const deptScopedMaterials = useMemo(() => {
    /* Requirement 4: a DEPARTMENT is selected and its ever-requested set has
       loaded → that set IS the sheet (plus anything a counter added). The
       category whitelist is deliberately NOT applied on top of it: the
       requested set is the tighter, evidence-based scope, and an item the
       department genuinely requisitioned must never be hidden because someone
       forgot to tick its category. Same reason the old deptItemIds
       intersection is skipped here — that set (ever ISSUED) is a subset of
       this one, so applying it would silently re-narrow the owner's rule. */
    if (deptScopeActive) {
      const seen = new Set<string>();
      const out: any[] = [];
      for (const r of [...deptRequested!.rows, ...extraRows]) {
        const id = String(r.id);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(r);
      }
      return out;
    }
    // Store / Overall, or the scope call has not answered yet / failed —
    // previous behaviour, byte for byte.
    let list = materials;
    if (hasDeptChoice && deptCategorySet) {
      list = list.filter((m: any) => deptCategorySet.has(String(m.category || '').trim().toLowerCase()));
    }
    // Non-privileged: further intersect with the dept's item set so staff
    // only count what was actually issued to (or counted by) their dept.
    if (!canSeeAllDepts && deptItemIds) {
      list = list.filter((m: any) => deptItemIds.has(String(m.id)));
    }
    return list;
  }, [materials, hasDeptChoice, deptCategorySet, canSeeAllDepts, deptItemIds, deptScopeActive, deptRequested, extraRows]);
  /** Ids on the sheet — the escape hatch must not offer a duplicate. */
  const sheetIds = useMemo(() => new Set(deptScopedMaterials.map((m: any) => String(m.id))), [deptScopedMaterials]);
  // Is a real category whitelist in effect for the active dept? Gates the base
  // CATEGORIES union below (no point offering categories outside the whitelist)
  // and the "no filter configured" fallback hint in the modal. Dept scoping
  // narrows harder still, so it counts as "filtered" too.
  const isDeptFiltered = (!!activeDeptId && !!deptCategorySet) || deptScopeActive;
  // Stale category from a previously-selected dept could blank the list.
  useEffect(() => { setClosingCategory(''); }, [activeDeptId]);

  /* Seed an empty entry for every row on the sheet. openClosingStock seeds from
     the /api/inventory list; a dept-scoped sheet (and anything added through
     the escape hatch) can carry rows that list never had, and an unseeded row
     would leave React flipping its inputs between controlled and uncontrolled.
     Only ever ADDS missing keys — a value already typed is never touched. */
  useEffect(() => {
    if (!closingStockOpen) return;
    setClosingItems(prev => {
      let changed = false;
      const next = { ...prev };
      for (const m of deptScopedMaterials) {
        const id = String(m.id);
        if (!next[id]) { next[id] = { physical_stock: '', notes: '' }; changed = true; }
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closingStockOpen, deptScopedMaterials]);

  /* ── Requirement 4, made VISIBLE ─────────────────────────────────────────
     "Show the count so the scoping is visible rather than mysterious." A
     counter must never have to wonder why an item is missing, and must always
     see that store-wide mode is a different, unscoped thing. Rendered on all
     three counting surfaces: the location board, a location's count screen and
     the Record Closing Stock sheet. Carries the escape hatch when the caller
     supplies an onAdd. Deliberately says nothing about system stock or
     variance — blind counts are untouched by scoping. */
  const activeDeptName = departments.find((d: any) => d.id === activeDeptId)?.name
    || (activeDeptId ? 'this department' : 'Store / Overall');
  const renderDeptScope = (onAdd?: (row: any) => void) => {
    if (!activeDeptId) {
      return (
        <div className="flex items-start gap-2 rounded-xl border border-[#E8D5C4] bg-[#FFF8F0] px-4 py-2.5 text-xs text-[#6B5744]">
          <ListChecks className="w-4 h-4 flex-shrink-0 mt-0.5 text-[#8B7355]" />
          <span>
            <strong>Store / Overall</strong> — the full central list, not scoped to any department.
            Pick a department above to count only the items that department actually uses.
          </span>
        </div>
      );
    }
    if (deptScopeError) {
      return (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>
            Could not load {activeDeptName}&apos;s item list, so the full list is shown instead —
            nothing is hidden and nothing is un-countable. Counts still save against {activeDeptName}.
            Tell an admin if this keeps happening.
          </span>
        </div>
      );
    }
    if (!deptScopeActive) {
      return (
        <div className="flex items-center gap-2 rounded-xl border border-[#E8D5C4] bg-[#FFF8F0] px-4 py-2.5 text-xs text-[#8B7355]">
          {deptScopeLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ListChecks className="w-4 h-4" />}
          Loading {activeDeptName}&apos;s item list…
        </div>
      );
    }
    const ever = deptRequested!.count;
    return (
      <div className="rounded-xl border border-[#E8D5C4] bg-[#FFF8F0] px-4 py-2.5 space-y-2">
        <div className="flex items-start gap-2 text-xs text-[#6B5744]">
          <ListChecks className="w-4 h-4 flex-shrink-0 mt-0.5 text-[#af4408]" />
          <span>
            <strong>{activeDeptName} uses {ever} item{ever === 1 ? '' : 's'}</strong> — every material this
            department has ever requisitioned, with no time limit, so something it asked for months ago
            stays on the list. Items it has never requested (or only ever had rejected) are not shown.
            {extraRows.length > 0 && (
              <> {' '}<span className="text-[#af4408] font-medium">+{extraRows.length} added by hand this session.</span></>
            )}
          </span>
        </div>
        {onAdd && (
          <AddOffListItem
            deptId={activeDeptId}
            deptName={activeDeptName}
            existingIds={sheetIds}
            onAdd={onAdd}
          />
        )}
      </div>
    );
  };

  /** Category options grouped by super_category so the modal dropdown renders
   *  with <optgroup> headers. Mirrors the derivation on the Raw Materials page,
   *  but scoped to the active department's items. */
  const availableCategories = useMemo(() => {
    const live = new Set(deptScopedMaterials.map(m => (m.category || '').trim()).filter(Boolean));
    const all = isDeptFiltered ? live : new Set<string>([...CATEGORIES, ...live]);
    return Array.from(all).sort((a, b) => a.localeCompare(b));
  }, [deptScopedMaterials, isDeptFiltered]);

  const categoryGroups = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const m of deptScopedMaterials) {
      const cat = (m.category || '').trim();
      if (!cat) continue;
      const sup = ((m as any).super_category || '').trim() || '(Other)';
      if (!map.has(sup)) map.set(sup, new Set());
      map.get(sup)!.add(cat);
    }
    for (const c of availableCategories) {
      const found = Array.from(map.values()).some(set => set.has(c));
      if (!found) {
        if (!map.has('(Other)')) map.set('(Other)', new Set());
        map.get('(Other)')!.add(c);
      }
    }
    // Sub-recipe categories get their own group, so picking one narrows the
    // sheet to the semi-finished section instead of emptying it.
    // Merge, never overwrite: a raw material could legitimately sit under a
    // super_category spelled 'Semi-finished', and clobbering its set would drop
    // those categories out of the picker entirely.
    const semiCats = subRecipes.map(s => (s.category || 'sub-recipe').trim()).filter(Boolean);
    if (semiCats.length) {
      if (!map.has('Semi-finished')) map.set('Semi-finished', new Set());
      for (const c of semiCats) map.get('Semi-finished')!.add(c);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => (a === '(Other)' ? 1 : b === '(Other)' ? -1 : a.localeCompare(b)))
      .map(([sup, set]) => ({ sup, cats: Array.from(set).sort((a, b) => a.localeCompare(b)) }));
  }, [deptScopedMaterials, availableCategories, subRecipes]);

  const fetchMaterials = async () => {
    try {
      // Dept-scoped modal list:
      // - Staff (no dept choice): omit scope=all so the server's dept-category
      //   whitelist returns exactly their MAIN dept's items. A dept with no
      //   whitelist configured → server applies no filter (full list), so they
      //   are never stuck with an empty list (a hint notes the fallback).
      // - Privileged (dept picker): keep scope=all and client-filter by the
      //   SELECTED department via deptScopedMaterials, so switching depts
      //   re-filters live without refetching.
      // exclude_store_mapped=1 — store-mapped liquor is counted in its own
      // store's closing, so the CENTRAL Record modal must never list it.
      const res = await fetch(hasDeptChoice
        ? '/api/inventory?scope=all&exclude_store_mapped=1'
        : '/api/inventory?exclude_store_mapped=1');
      if (res.ok) {
        const json = await res.json();
        setMaterials(json.materials ?? []);
        return json.materials ?? [];
      }
    } catch (_) {}
    return [];
  };

  /* The semi-finished count sheet (req 1) — GET /api/closing-stock/semi returns
     EVERY active sub-recipe with this date+department's count attached when one
     exists. Sub-recipes carry no department and no storage location, so they are
     offered to every counter rather than filtered out; a section that holds none
     simply leaves them blank. Costing is the SERVER's job (cost_per_unit, ₹ per
     yield_unit) — this fetch only needs the id / name / yield basis. */
  const fetchSubRecipes = async (forDate?: string) => {
    try {
      const qs = new URLSearchParams({ date: forDate || closingDate, department_id: activeDeptId });
      const res = await fetch(`/api/closing-stock/semi?${qs}`);
      if (!res.ok) return [] as SubRecipeRow[];
      const json = await res.json();
      const list: SubRecipeRow[] = (json.items || []).map((s: any) => ({
        id: String(s.sub_recipe_id),
        name: String(s.name || ''),
        category: s.category || 'sub-recipe',
        yield_unit: String(s.yield_unit || '').trim(),
        cost_per_unit: Number(s.cost_per_unit) || 0,
      }));
      setSubRecipes(list);
      return list;
    } catch { return [] as SubRecipeRow[]; }
  };

  /**
   * Save the semi-finished half of a submit. Sub-recipe counts go to their OWN
   * route (they land in closing_stock_semi — closing_stock.material_id is NOT
   * NULL with an FK to raw_materials, so a sub-recipe id cannot live there).
   *
   * Two POSTs means two ways to fail, so the outcome is reported honestly
   * rather than folded into the raw-material count: silently dropping a
   * counter's numbers is the exact failure this feature exists to end.
   */
  const postSemiCounts = async (
    forDate: string,
    rows: { sub_recipe_id: string; physical_stock: number; notes: string }[],
    errors: string[],
  ): Promise<number> => {
    if (rows.length === 0) return 0;
    try {
      const res = await api('/api/closing-stock/semi', {
        method: 'POST',
        body: { date: forDate, department_id: activeDeptId, items: rows },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        errors.push(`Semi-finished counts were NOT saved: ${json.error || `HTTP ${res.status}`}`);
        return 0;
      }
      for (const e of json.errors || []) errors.push(e);
      const saved = Number(json.success) || 0;
      if (saved < rows.length) {
        const missed = rows.length - saved;
        errors.push(`${missed} semi-finished count${missed === 1 ? ' was' : 's were'} not saved.`);
      }
      return saved;
    } catch (e: any) {
      errors.push(`Semi-finished counts were NOT saved: ${e.message}`);
      return 0;
    }
  };

  const openClosingStock = async () => {
    const openDate = new Date().toISOString().split('T')[0];
    setClosingStockOpen(true);
    setClosingDate(openDate);
    setClosingResult(null);
    setValued(null);
    setClosingSearch('');
    setClosingCategory('');
    setShowHistory(false);
    // Pull the full material list, then pre-seed an empty entry per material.
    // openDate is passed explicitly — setClosingDate above has not applied yet.
    const [list, subs] = await Promise.all([fetchMaterials(), fetchSubRecipes(openDate)]);
    const seed: Record<string, { physical_stock: string; notes: string }> = {};
    for (const m of list) {
      seed[m.id] = { physical_stock: '', notes: '' };
    }
    setClosingItems(seed);
    const semiSeed: Record<string, { physical_stock: string; notes: string }> = {};
    for (const s of subs) semiSeed[s.id] = { physical_stock: '', notes: '' };
    setClosingSemi(semiSeed);
    fetchClosingHistory();
  };

  /**
   * Re-read the sheet the server just SAVED, so the rate and Quantity × Rate on
   * screen are the stored ones (req 2/3). Deliberately a fresh GET rather than a
   * client-side calculation: the browser has no business resolving a rate, and a
   * count is a dated record — the server's stored figure is the only truth.
   */
  const loadValuedSheet = async (d: string) => {
    try {
      const qs = new URLSearchParams({ date: d, department_id: activeDeptId || '__store__' });
      // Two sheets, two tables, two routes: raw materials from closing_stock,
      // sub-recipes from closing_stock_semi (counted_only=1 → just the rows
      // actually saved, not the whole 68-item catalogue).
      const semiQs = new URLSearchParams({ date: d, department_id: activeDeptId, counted_only: '1' });
      const [res, semiRes] = await Promise.all([
        fetch(`/api/closing-stock?${qs}`),
        fetch(`/api/closing-stock/semi?${semiQs}`),
      ]);
      if (!res.ok) { setValued(null); return; }
      const json = await res.json();
      const semiJson = semiRes.ok ? await semiRes.json().catch(() => ({})) : {};
      const items: any[] = json.items || [];
      const semi: any[] = semiJson.items || [];
      // The sheet total is the SUM OF THE LINES SHOWN — every addend is a
      // server-stored total_value, and a footer that disagreed with its own
      // column would be a bug. (A summary total from the API could legitimately
      // cover a wider scope than this department-filtered list.) Money adds up
      // across materials; quantities never do.
      const total = sumValue(items) + sumValue(semi);
      // Did this build actually value anything? If the API predates the
      // valuation columns, say so instead of printing a column of em-dashes.
      const priced = items.some(i => i.total_value != null || i.rate_source != null)
        || semi.some(s => s.total_value != null || s.rate_per_unit != null);
      setValued({ date: d, items, semi, total, priced });
    } catch { setValued(null); }
  };

  /**
   * The history index. Raw-material days and semi-finished days are separate
   * indexes (separate tables), so they are UNIONED here: a day on which only
   * sub-recipes were counted must still appear, and a day with both must show
   * one combined closing value rather than the raw half only.
   */
  const fetchClosingHistory = async () => {
    try {
      const [res, semiRes] = await Promise.all([
        fetch('/api/closing-stock'),
        fetch('/api/closing-stock/semi'),
      ]);
      const json = res.ok ? await res.json() : { dates: [] };
      const semiJson = semiRes.ok ? await semiRes.json().catch(() => ({ dates: [] })) : { dates: [] };
      const byDate = new Map<string, any>();
      for (const d of json.dates || []) byDate.set(d.date, { ...d });
      for (const s of semiJson.dates || []) {
        const hit = byDate.get(s.date);
        if (hit) {
          hit.semi_count = s.item_count || 0;
          hit.total_value = (Number(hit.total_value) || 0) + (Number(s.total_value) || 0);
        } else {
          byDate.set(s.date, {
            date: s.date, item_count: 0, semi_count: s.item_count || 0,
            total_value: Number(s.total_value) || 0,
            total_variance_value: 0, shortage_count: 0, excess_count: 0,
          });
        }
      }
      setClosingHistory([...byDate.values()].sort((a, b) => String(b.date).localeCompare(String(a.date))));
    } catch (_) {}
  };

  const viewHistoryDate = async (d: string) => {
    setHistoryDate(d);
    setHistoryLoading(true);
    try {
      // Raw-material counts, plus the same date's semi-finished counts across
      // every department (counted_only=1 → saved rows, not the full catalogue).
      const [res, semiRes] = await Promise.all([
        fetch(`/api/closing-stock?date=${d}`),
        fetch(`/api/closing-stock/semi?date=${d}&counted_only=1`),
      ]);
      const semiJson = semiRes.ok ? await semiRes.json().catch(() => ({})) : {};
      setHistorySemi(semiJson.items || []);
      if (res.ok) {
        const json = await res.json();
        setHistoryItems(json.items || []);
        setHistorySummary(json.summary || null);
        setByArea(json.summary?.by_area || []);
      }
    } catch (_) {}
    setHistoryLoading(false);
  };

  /**
   * Download the counted sheet for the ONE date currently open in History.
   *
   * BLIND COUNTS APPLY TO THE FILE, NOT JUST THE SCREEN. System Stock, Variance
   * and Variance (₹) are admin-only in the table above; a CSV that carried them
   * for everyone would hand a counter the very figure a blind count exists to
   * withhold, and in the most durable, most shareable form there is. So the
   * columns are BUILT from the same isAdmin flag the table branches on rather
   * than assembled and filtered afterwards — a column cannot survive here by
   * being forgotten in one place.
   *
   * Quantities lead with the PURCHASE unit, and the recipe figure travels in its
   * own column so the sheet stays arithmetic-checkable — but only where the two
   * actually differ (packFactor > 1), which is exactly when the table prints its
   * "= N g" hint. csvQty keeps every number ungrouped: toLocaleString's commas
   * would make Excel read 1,250 as text.
   *
   * Sub-recipes are counted in their own yield unit and have no purchase unit,
   * no pack factor and no system figure — their system/variance cells are the
   * same honest blank the table draws as a dash, never a 0 that would read as
   * "counted and matched".
   */
  const downloadHistoryCsv = () => {
    if (!historyDate) return;
    const rows: Record<string, string | number>[] = [];

    for (const item of historyItems) {
      const hm = { unit: item.unit, purchase_unit: item.purchase_unit, pack_size: item.pack_size };
      const converts = packFactor(hm) > 1;
      const r: Record<string, string | number> = {
        Type: 'Raw material',
        Material: item.material_name ?? '',
        Category: categoryLabel(item.category),
      };
      if (isAdmin) r['System Stock'] = csvQty(toPurchaseQty(Number(item.system_stock) || 0, hm));
      r['Physical Stock'] = csvQty(toPurchaseQty(Number(item.physical_stock) || 0, hm));
      r['Unit'] = item.purchase_unit || item.unit || '';
      r['Physical (recipe)'] = converts ? csvQty(Number(item.physical_stock) || 0) : '';
      r['Recipe Unit'] = converts ? (item.unit || '') : '';
      r['Last Purchase Price'] = item.rate_per_purchase_unit == null ? '' : Number(item.rate_per_purchase_unit);
      r['Total Value'] = item.total_value == null ? '' : Number(item.total_value);
      if (isAdmin) r['Variance'] = csvQty(toPurchaseQty(Number(item.variance) || 0, hm));
      if (isAdmin) r['Variance (Rs)'] = item.variance_value == null ? '' : Number(item.variance_value);
      r['Notes'] = item.notes || '';
      rows.push(r);
    }

    for (const s of historySemi) {
      const r: Record<string, string | number> = {
        Type: 'Semi-finished',
        Material: s.name ?? '',
        Category: categoryLabel(s.category || 'sub-recipe'),
      };
      if (isAdmin) r['System Stock'] = '';
      r['Physical Stock'] = csvQty(Number(s.physical_stock) || 0);
      r['Unit'] = s.unit || s.yield_unit || '';
      r['Physical (recipe)'] = '';
      r['Recipe Unit'] = '';
      r['Last Purchase Price'] = s.rate_per_unit == null ? '' : Number(s.rate_per_unit);
      r['Total Value'] = s.total_value == null ? '' : Number(s.total_value);
      if (isAdmin) r['Variance'] = '';
      if (isAdmin) r['Variance (Rs)'] = '';
      r['Notes'] = s.notes || '';
      rows.push(r);
    }

    if (!rows.length) return;
    // Papa.unparse (already a dependency of this page) handles quoting for
    // material names that contain a comma or a quote — hand-joining would
    // corrupt those rows silently.
    const blob = new Blob([Papa.unparse(rows)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `closing-stock-${historyDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const updateClosingItem = (materialId: string, field: 'physical_stock' | 'notes', value: string) => {
    setClosingItems(prev => ({
      ...prev,
      [materialId]: { ...prev[materialId], [field]: value },
    }));
  };

  const updateClosingSemi = (subId: string, field: 'physical_stock' | 'notes', value: string) => {
    setClosingSemi(prev => {
      // Default the row in case the seed missed it (a sub-recipe added while the
      // modal was open) — without this the other field would come back
      // undefined and React would flip the input to uncontrolled.
      const row = prev[subId] || { physical_stock: '', notes: '' };
      return { ...prev, [subId]: { ...row, [field]: value } };
    });
  };

  /**
   * The semi-finished rows a submit should carry. No pack factor is applied —
   * a sub-recipe is counted and costed in its OWN yield_unit, so ×packFactor
   * here would be a category error (see valueSemiCount in closing-valuation.ts).
   */
  const collectSemiEntries = (errors: string[]) => {
    const out: { sub_recipe_id: string; physical_stock: number; notes: string }[] = [];
    for (const s of subRecipes) {
      const v = closingSemi[s.id];
      if (!v || v.physical_stock === '') continue;
      const q = parseFloat(v.physical_stock);
      if (isNaN(q) || q < 0) { errors.push(`${s.name}: invalid count "${v.physical_stock}"`); continue; }
      out.push({ sub_recipe_id: s.id, physical_stock: q, notes: v.notes || '' });
    }
    return out;
  };

  const submitClosingStock = async () => {
    setClosingSubmitting(true);
    setClosingResult(null);
    try {
      // Only submit rows in the CURRENT dept-scoped list — a privileged user
      // who filled counts then switched department must not save the hidden
      // rows under the newly-selected department.
      const allowedIds = new Set(deptScopedMaterials.map((m: any) => String(m.id)));
      const byIdSubmit = new Map(deptScopedMaterials.map((m: any) => [String(m.id), m]));
      const itemsToSubmit = Object.entries(closingItems)
        .filter(([id, v]) => v.physical_stock !== '' && allowedIds.has(String(id)))
        .map(([materialId, v]) => {
          // The modal takes counts in PURCHASE units; storage stays RECIPE
          // (canon). ×packFactor here, once, at the storage boundary.
          const mat: any = byIdSubmit.get(String(materialId));
          const pf = mat ? packFactor(mat) : 1;
          return {
            material_id: materialId,
            physical_stock: Math.round(parseFloat(v.physical_stock) * pf * 1e6) / 1e6,
            notes: v.notes,
          };
        });

      // Semi-finished counts go to their own route (closing_stock_semi).
      const errors: string[] = [];
      const semiToSubmit = collectSemiEntries(errors);

      if (itemsToSubmit.length === 0 && semiToSubmit.length === 0) {
        setClosingResult({ success: 0, errors: [...errors, 'Enter a physical count for at least one material or sub-recipe'] });
        setClosingSubmitting(false);
        return;
      }

      let rawSaved = 0;
      // Read the server's own verdict on each variance instead of assuming one.
      // The tick does NOT decide this on its own: department rows are carved out
      // server-side and stay pending even when it is on, and a blocked approval
      // falls back to pending with a reason in `errors`.
      let rawPending = 0, rawApplied = 0;
      if (itemsToSubmit.length > 0) {
        const res = await api('/api/closing-stock', {
          method: 'POST',
          // department_id scopes this batch of counts to the active department
          // ('' = store/overall). Plain users are pinned to their own department.
          body: { date: closingDate, items: itemsToSubmit, adjust_stock: adjustStockModal, department_id: activeDeptId },
        });
        const json = await res.json();
        // A REJECTED REQUEST ANSWERS { error: "..." }, NOT { errors: [...] }.
        // Reading only the plural array meant a 400 pushed nothing, every count
        // fell to 0, and the banner said "0 saved" with no reason given — the
        // user cannot tell a refused date from an empty sheet. Surface it.
        if (!res.ok) {
          errors.push(String(json?.error || `Save failed (HTTP ${res.status})`));
          // AND STOP. Semi-finished counts post to a DIFFERENT route with the
          // SAME closingDate. Both now run the one shared date guard
          // (lib/closing-date), so in practice the semi half would refuse for
          // the same reason — but stopping here is what GUARANTEES it. Two
          // routes agreeing today is not the same as two routes that cannot
          // disagree tomorrow, and the failure mode is a half-recorded day.
          // Whatever refused the raw counts refuses the whole submit.
          setClosingResult({ success: 0, errors, semi: 0, pending: 0, applied: 0 });
          return;
        }
        for (const e of json.errors || []) errors.push(e);
        rawSaved = json.success || 0;
        rawPending = json.pending || 0;
        rawApplied = json.applied || 0;
      }
      const semiSaved = await postSemiCounts(closingDate, semiToSubmit, errors);
      setClosingResult({ success: rawSaved, errors, semi: semiSaved, pending: rawPending, applied: rawApplied });
      if (rawSaved > 0 || semiSaved > 0) {
        await fetchMaterials();
        await fetchClosingHistory();
        await reloadLocations();
        // Show the sheet the server actually stored: rate + Quantity × Rate.
        await loadValuedSheet(closingDate);
      }
    } catch (err: any) {
      setClosingResult({ success: 0, errors: [err.message] });
    } finally {
      setClosingSubmitting(false);
    }
  };

  // --- CSV template download + bulk upload -----------------------------
  // Mirror the modal's manual save exactly: the template's Unit column now
  // carries the PURCHASE unit and counts are entered on that basis; the
  // parser converts to recipe units before POSTing (storage never changes
  // basis). Old files whose Unit column says the recipe unit still parse
  // correctly — the row's own Unit cell decides the basis. adjust_stock is
  // FORCED off for the CSV path even for an admin: a spreadsheet nobody has read
  // line by line must never self-approve its own variances onto system stock.
  // Every variance in an uploaded file goes to the approval queue.
  const csvEscape = (v: any) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Blind count: non-admins get a template WITHOUT the system-stock column.
  //
  // ADDITIVE header change (req 1): `Type` and `sub_recipe_id` are NEW columns;
  // every previously-emitted column keeps its exact name, and the parser matches
  // by header name, so a file downloaded before this change still uploads. Type
  // is what stops a re-upload confusing "Green Chutney" the sub-recipe with a
  // raw material of the same name — the two live in different tables and are
  // valued by completely different rules.
  const CSV_COLS = isAdmin
    ? ['Type', 'material_id', 'sub_recipe_id', 'SKU', 'Name', 'Category', 'Unit', 'System stock', 'Physical count']
    : ['Type', 'material_id', 'sub_recipe_id', 'SKU', 'Name', 'Category', 'Unit', 'Physical count'];

  /* ══════════════════════════════════════════════════════════════════════════
   * ONE SOURCE FOR BOTH HALVES OF THE CSV CONTRACT
   * ══════════════════════════════════════════════════════════════════════════
   * The template EXPORTS a set of rows; the upload must RESOLVE that same set.
   * They are two halves of one contract, so they read ONE source and cannot
   * drift. When they were derived separately the template emitted a
   * department's ever-requested rows (server-derived, deliberately NOT limited
   * to the dept category whitelist — see deptScopedMaterials) while the parser
   * matched against the /api/inventory list, so a counter who filled in the
   * sheet the app had just handed them was told the rows do not exist.
   * Measured on the live DB copy 2026-07-31: for a staff counter pinned to
   * Akan Bar, 114 of the 148 rows the template emitted came back unmatched
   * (FROZEN BLUEBERRIES, ICE CUBES, MASCARPONE CHEESE 400 GM, …) because the
   * Bar whitelist is liquor categories that Central closing excludes.
   *
   * The source IS deptScopedMaterials — the rows on screen — so the sheet, the
   * template, the parser and submitClosingStock's allowedIds all agree on what
   * this department is counting. The only fallback is the one the template
   * already carried: when the modal's material list has not loaded yet,
   * re-fetch and re-apply the SAME narrowing the memo applies. A dept-scoped
   * sheet never needs it — those rows come from the server, not /api/inventory.
   * ────────────────────────────────────────────────────────────────────────── */
  const closingSheetRows = async (): Promise<any[]> => {
    if (deptScopeActive || materials.length) return deptScopedMaterials;
    const all = await fetchMaterials();
    let list = (hasDeptChoice && deptCategorySet)
      ? all.filter((m: any) => deptCategorySet.has(String(m.category || '').trim().toLowerCase()))
      : all;
    // Same dept item-set intersection as deptScopedMaterials.
    if (!canSeeAllDepts && deptItemIds) {
      list = list.filter((m: any) => deptItemIds.has(String(m.id)));
    }
    return list;
  };
  /** The semi-finished half of the same contract — one source, same reason. */
  const closingSheetSubRecipes = async (): Promise<SubRecipeRow[]> =>
    (subRecipes.length ? subRecipes : await fetchSubRecipes());

  const downloadClosingTemplate = async () => {
    // Export the FILTERED set — the rows this user/department is being asked
    // to count — not the full catalogue. uploadClosingCsv resolves against the
    // SAME closingSheetRows()/closingSheetSubRecipes() sets.
    const mats = await closingSheetRows();
    const subs = await closingSheetSubRecipes();
    const lines = [CSV_COLS.join(',')];
    for (const m of mats) {
      const base = [CSV_TYPE_RAW, m.id, '', m.sku || '', m.name || '', (m.super_category || m.category || ''), (m.purchase_unit || m.unit || '')];
      // Physical count column left blank for the counter; system stock only for
      // admins — in the SAME purchase unit the Unit column declares. Shared
      // toPurchaseQty, so the template can never drift from the on-screen figure.
      const sysPU = m.current_stock == null ? 0 : toPurchaseQty(m.current_stock, m);
      lines.push((isAdmin ? [...base, sysPU, ''] : [...base, '']).map(csvEscape).join(','));
    }
    // Semi-finished section (req 1). Unit is the sub-recipe's OWN yield_unit —
    // there is no purchase unit and no pack conversion, so the count goes in
    // exactly as written. The System stock cell stays blank even for admins:
    // sub-recipes carry no system figure, and a 0 there would read as one.
    for (const s of subs) {
      const base = [CSV_TYPE_SEMI, '', s.id, '', s.name, s.category || 'sub-recipe', s.yield_unit];
      lines.push((isAdmin ? [...base, '', ''] : [...base, '']).map(csvEscape).join(','));
    }
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `closing-stock-template-${closingDate}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };
  const uploadClosingCsv = async (file: File) => {
    setClosingSubmitting(true);
    setClosingResult(null);
    try {
      // THE SAME SET THE TEMPLATE EXPORTED (see closingSheetRows above). Not
      // `materials` — that list is fetched separately and, for a dept-scoped
      // counter, does not contain the rows the template just handed them.
      const mats = await closingSheetRows();
      const subs = await closingSheetSubRecipes();
      const byId = new Map(mats.map(m => [String(m.id), m]));
      const bySku = new Map(mats.filter(m => m.sku).map(m => [String(m.sku).trim().toLowerCase(), m]));
      const byName = new Map(mats.map(m => [String(m.name).trim().toLowerCase(), m]));
      const subById = new Map(subs.map(s => [String(s.id), s]));
      const subByName = new Map(subs.map(s => [s.name.trim().toLowerCase(), s]));
      const text = await file.text();
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
      if (parsed.errors?.length) {
        setClosingResult({ success: 0, errors: ['CSV parse error: ' + parsed.errors[0].message] });
        return;
      }
      const rows = parsed.data as any[];
      const items: { material_id: string; physical_stock: number }[] = [];
      const semiItems: { sub_recipe_id: string; physical_stock: number; notes: string }[] = [];
      const errors: string[] = [];
      const get = (row: any, ...keys: string[]) => {
        for (const k of keys) if (row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
        return '';
      };
      /* An unmatched raw row now means "not on THIS sheet", which is a
         different problem from "no such material" and has a different remedy.
         Say which, and name the escape hatch — never leave a counter holding a
         number with nowhere to put it. */
      const notOnSheet = (label: string) => (deptScopeActive
        ? `${label}: not on ${activeDeptName}'s count sheet — add it with "Add an item not on this list" on the sheet, then download a fresh template (or check material_id / SKU / Name).`
        : `${label}: material not found (check material_id / SKU / Name)`);
      for (const row of rows) {
        const pc = get(row, 'Physical count', 'Physical Count', 'physical_count', 'physical count');
        if (pc === '') continue;                               // blank = not counted → skip
        const label = get(row, 'Name', 'name') || get(row, 'material_id') || get(row, 'sub_recipe_id') || get(row, 'SKU', 'sku') || 'row';
        const qty = parseFloat(pc);
        if (isNaN(qty) || qty < 0) { errors.push(`${label}: invalid physical count "${pc}"`); continue; }

        /* ── ITEM TYPE (req 1) ────────────────────────────────────────────
           A file downloaded from this page declares its type per row. A file
           without the column is an OLD template — every row in it was a raw
           material, so blank means RAW and the old round-trip is unchanged.
           Anything else is rejected rather than guessed: a sub-recipe counted
           as a raw material (or the reverse) would be valued by the wrong rule
           entirely — pack factor and ₹/purchase-unit versus ₹/yield-unit. */
        const typeCell = get(row, 'Type', 'type', 'Item type', 'item_type').toUpperCase();
        const subIdKey = get(row, 'sub_recipe_id', 'Sub recipe id', 'sub recipe id');
        const nameLower = get(row, 'Name', 'name').toLowerCase();
        const isSemi = typeCell === CSV_TYPE_SEMI || (typeCell === '' && !!subIdKey);
        if (typeCell !== '' && typeCell !== CSV_TYPE_RAW && typeCell !== CSV_TYPE_SEMI) {
          errors.push(`${label}: unknown Type "${typeCell}" — use ${CSV_TYPE_RAW} for a raw material or ${CSV_TYPE_SEMI} for a sub-recipe`);
          continue;
        }
        // A blank Type on a name that exists ONLY as a sub-recipe is a row from
        // a hand-built file. Ask for the Type rather than silently missing it.
        if (typeCell === '' && !subIdKey && nameLower && !byName.has(nameLower) && subByName.has(nameLower)) {
          errors.push(`${label}: this is a sub-recipe — set Type to ${CSV_TYPE_SEMI} (or fill sub_recipe_id) so it is not read as a raw material`);
          continue;
        }
        if (isSemi) {
          const s = (subIdKey && subById.get(subIdKey)) || (nameLower && subByName.get(nameLower));
          if (!s) { errors.push(`${label}: sub-recipe not found (check sub_recipe_id / Name)`); continue; }
          // Counted in the sub-recipe's OWN yield_unit — no pack conversion
          // exists, so the Unit cell may only confirm that unit.
          const unitCell = get(row, 'Unit', 'unit').toLowerCase();
          const yu = s.yield_unit.toLowerCase();
          if (unitCell !== '' && unitCell !== yu) {
            errors.push(`${label}: unit "${unitCell}" is not this sub-recipe's yield unit (${s.yield_unit})`);
            continue;
          }
          semiItems.push({ sub_recipe_id: s.id, physical_stock: qty, notes: get(row, 'Notes', 'notes') });
          continue;
        }

        const idKey = get(row, 'material_id');
        const skuKey = get(row, 'SKU', 'sku').toLowerCase();
        const nameKey = get(row, 'Name', 'name').toLowerCase();
        const m = (idKey && byId.get(idKey)) || (skuKey && bySku.get(skuKey)) || (nameKey && byName.get(nameKey));
        if (!m) { errors.push(notOnSheet(label)); continue; }
        // Basis comes from the row's own Unit cell: new templates declare the
        // purchase unit (count ×pack → recipe), old files declare the recipe
        // unit (raw). Anything else is ambiguous — reject the row rather than
        // guess a basis that could scale stock pack×.
        const pf = packFactor(m);
        const unitCell = get(row, 'Unit', 'unit').toLowerCase();
        const ru = String(m.unit || '').trim().toLowerCase();
        const pu = String(m.purchase_unit || m.unit || '').trim().toLowerCase();
        let recipeQty: number;
        if (unitCell === '' && pf > 1) {
          errors.push(`${label}: the Unit column is blank — write ${m.purchase_unit} (count in purchase units) or ${m.unit} (recipe units) so the basis is unambiguous`);
          continue;
        }
        if (unitCell === '' || unitCell === ru) recipeQty = qty;
        else if (unitCell === pu) recipeQty = Math.round(qty * pf * 1e6) / 1e6;
        else { errors.push(`${label}: unit "${unitCell}" matches neither ${m.unit} nor ${m.purchase_unit || m.unit}`); continue; }
        items.push({ material_id: m.id, physical_stock: recipeQty });
      }
      if (items.length === 0 && semiItems.length === 0) {
        setClosingResult({ success: 0, errors: errors.length ? errors : ['No physical counts found in the file'] });
        return;
      }
      let rawSaved = 0;
      // `applied` is structurally 0 on this path — adjust_stock is forced off for
      // a bulk file (see the header comment), so every variance in the sheet goes
      // to the approval queue. Still read it from the reply rather than hard-coding
      // 0, so the banner cannot drift from what the server actually did.
      let rawPending = 0, rawApplied = 0;
      if (items.length > 0) {
        const res = await api('/api/closing-stock', {
          method: 'POST',
          body: { date: closingDate, items, adjust_stock: false, department_id: activeDeptId },
        });
        const json = await res.json();
        // Same as the modal path: a rejection is { error }, not { errors }, and
        // the semi route shares this date. Report the reason and abandon the
        // whole upload rather than half-writing the day — see the note there
        // for why this does not lean on the two routes agreeing.
        if (!res.ok) {
          errors.push(String(json?.error || `Upload failed (HTTP ${res.status})`));
          setClosingResult({ success: 0, errors, semi: 0, pending: 0, applied: 0 });
          return;
        }
        for (const e of json.errors || []) errors.push(e);
        rawSaved = json.success || 0;
        rawPending = json.pending || 0;
        rawApplied = json.applied || 0;
      }
      // Sub-recipe rows from the same file go to the semi route.
      const semiSaved = await postSemiCounts(closingDate, semiItems, errors);
      setClosingResult({ success: rawSaved, errors, semi: semiSaved, pending: rawPending, applied: rawApplied });
      if (rawSaved > 0 || semiSaved > 0) {
        await fetchMaterials();
        await fetchClosingHistory();
        await reloadLocations();
        // req 2/3 — read back the sheet the server valued and stored, so the
        // counter immediately sees the rate applied and Quantity × Rate.
        await loadValuedSheet(closingDate);
      }
    } catch (err: any) {
      setClosingResult({ success: 0, errors: [err.message] });
    } finally {
      setClosingSubmitting(false);
    }
  };

  const closingFiltered = deptScopedMaterials.filter(m => {
    if (closingSearch) {
      if (!m.name.toLowerCase().includes(closingSearch.toLowerCase())) return false;
    }
    if (closingCategory && m.category !== closingCategory) return false;
    return true;
  });

  /* Semi-finished rows obey the same search / category filters. Sub-recipes have
     no department and no storage location, so they are NOT dept-scoped: the
     kitchen that holds Mint Chutney must be able to count it whatever tier the
     counter is. Categories come from sub_recipes.category. */
  const semiFiltered = subRecipes.filter(s => {
    if (closingSearch && !s.name.toLowerCase().includes(closingSearch.toLowerCase())) return false;
    if (closingCategory && (s.category || 'sub-recipe') !== closingCategory) return false;
    return true;
  });
  const semiFilledCount = subRecipes.filter(s => (closingSemi[s.id]?.physical_stock ?? '') !== '').length;

  /* HISTORY VALUATION (req 4) — every figure below comes from the stored row:
     closing_stock.rate_per_purchase_unit / rate_source / total_value, written
     at count time. A historical sheet is never re-priced from today's rates. */
  // Sum of the stored line values actually listed below, so the footer always
  // equals its own column (a summary figure from the API could cover a wider
  // scope than the rows on screen).
  const historyValueTotal = sumValue(historyItems) + sumValue(historySemi);
  /** Does this date have any stored valuation at all? Counts saved before the
   *  valuation columns existed have none — say so instead of showing ₹0. */
  const historyPriced = historyItems.some((i: any) => i.total_value != null || i.rate_source != null)
    || historySemi.some((s: any) => s.total_value != null || s.rate_per_unit != null);
  const historyUnvalued = unvaluedCount([...historyItems, ...historySemi]);

  const reloadLocations = async () => {
    setLoading(true);
    // Scope the progress cards to the department we're recording under, so
    // "counted today" matches the counts this user is actually saving.
    const d = await fetch(`/api/closing-stock/locations?date=${date}&department_id=${encodeURIComponent(activeDeptId)}`).then(r => r.json());
    setLocations(d.locations || []);
    setTotals(d.totals || { locations: 0, items: 0, counted: 0 });
    setLoading(false);
  };
  useEffect(() => { reloadLocations(); /* eslint-disable-next-line */ }, [date, activeDeptId]);

  // Per-area rollup for the top-level date — admin / HOD / store-manager only.
  // Uses the summary.by_area block, which is date-scoped and independent of any
  // department filter, so it always reflects every area's overall closing value.
  const reloadRollup = async () => {
    if (!canSeeAllDepts) { setByArea([]); return; }
    try {
      const json = await fetch(`/api/closing-stock?date=${date}`).then(r => r.json());
      setByArea(json?.summary?.by_area || []);
    } catch { setByArea([]); }
  };
  useEffect(() => { reloadRollup(); /* eslint-disable-next-line */ }, [date, canSeeAllDepts]);

  const openLocation = async (loc: string) => {
    setActive(loc);
    setItemsLoading(true);
    setEntries({});
    setCases({});
    setLoose({});
    setSavedFlash(null);
    const qs = new URLSearchParams({ date, location: loc === '— Unassigned —' ? '__unassigned__' : loc, department_id: activeDeptId });
    const d = await fetch(`/api/closing-stock/by-location?${qs}`).then(r => r.json());
    setItems(d.items || []);
    setItemsLoading(false);
  };

  // Reset filters when switching to a different storage location
  useEffect(() => { setCategoryFilter(''); setItemSearch(''); }, [active]);
  // Changing the active department re-scopes the open location's counts too, so
  // today_count reflects the newly-selected department (not a stale one).
  useEffect(() => { if (active) openLocation(active); /* eslint-disable-next-line */ }, [activeDeptId]);
  // Deep link: drill into the requested area as soon as the list exists.
  useEffect(() => {
    if (!pendingLocation || locations.length === 0) return;
    const hit = locations.find(l => l.location === pendingLocation);
    if (hit) openLocation(hit.location);
    setPendingLocation(null);
    /* eslint-disable-next-line */
  }, [pendingLocation, locations]);

  // List of distinct categories present in the current location, with item counts.
  // Powers the chip strip above the count table. Counts respect the search box
  // and the "uncounted only" toggle so the chip labels show what you'd actually see.
  const categoryCounts = useMemo(() => {
    const m = new Map<string, number>();
    const q = itemSearch.trim().toLowerCase();
    for (const i of items) {
      if (filterUncountedOnly && i.today_count != null) continue;
      if (q && !i.name.toLowerCase().includes(q) && !(i.sku || '').toLowerCase().includes(q)) continue;
      const k = i.super_category || i.category || 'Uncategorised';
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].map(([name, count]) => ({ name, count }))
                          .sort((a, b) => b.count - a.count);
  }, [items, filterUncountedOnly, itemSearch]);

  const visibleItems = useMemo(() => {
    const q = itemSearch.trim().toLowerCase();
    return items.filter(i => {
      if (filterUncountedOnly && i.today_count != null) return false;
      if (categoryFilter && (i.super_category || i.category || 'Uncategorised') !== categoryFilter) return false;
      if (q && !i.name.toLowerCase().includes(q) && !(i.sku || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, filterUncountedOnly, categoryFilter, itemSearch]);

  // Total physical count in RECIPE units:
  //   cases × (case_size × pack_size) + bottles × pack_size + loose units.
  const physicalFor = (it: Item, casesRaw?: string, bottlesRaw?: string, looseRaw?: string): number | null => {
    // packFactor guards pack_size with recipe-unit ≠ purchase-unit (same rule as
    // /api/purchases) — kg/kg pack rows like BUTCHERY COVER 15KG convert ×1.
    const packSize = packFactor(it);
    const caseSize = it.case_size && it.case_size > 1 ? it.case_size : 1;
    const num = (s?: string) => (s != null && s !== '' && !isNaN(Number(s))) ? Number(s) : null;
    const c = num(casesRaw), b = num(bottlesRaw), l = num(looseRaw);
    if (c == null && b == null && l == null) return null;
    return (c ?? 0) * caseSize * packSize + (b ?? 0) * packSize + (l ?? 0);
  };

  const pendingEntries = useMemo(() => {
    const out: { material_id: string; physical: number }[] = [];
    for (const it of items) {
      const phys = physicalFor(it, cases[it.id], entries[it.id], loose[it.id]);
      if (phys != null) out.push({ material_id: it.id, physical: phys });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, cases, entries, loose]);

  const saveAll = async () => {
    if (pendingEntries.length === 0) return;
    setSaving(true);
    try {
      const payload = pendingEntries.map(({ material_id, physical }) => ({ material_id, physical_stock: physical }));
      const r = await api('/api/closing-stock', {
        method: 'POST',
        // Scope these location counts to the active department ('' = store/overall).
        body: { date, items: payload, adjust_stock: adjustStock, department_id: activeDeptId },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert(j.error || 'Save failed');
      } else {
        /* Say what became of the variances, not just how many rows were written.
           One save can produce both outcomes: with the tick on, central rows are
           approved on the spot (`applied`) while a department-scoped count — or
           a row the server refused to approve — stays in the queue (`pending`).
           The errors the route pushes ("count saved, but system stock was NOT
           adjusted — …") were being dropped on the floor here; they are the only
           place the counter learns why a row they expected to move did not. */
        const errs: string[] = Array.isArray(j.errors) ? j.errors : [];
        const flash = {
          tone: (errs.length ? 'warn' : (j.applied ? 'applied' : 'ok')) as 'ok' | 'applied' | 'warn',
          // BLIND COUNTS: the applied/pending clauses are ADMIN-ONLY, and this is
          // load-bearing, not cosmetic. "N sent for variance approval" answers
          // "does my figure differ from system stock?" — a counter can save one
          // item, watch the clause appear or vanish, and bisect their way to
          // raw_materials.current_stock in a handful of saves. That is exactly
          // what by-location/route.ts blinds the System and Variance columns to
          // prevent. A non-admin gets the plain count back and nothing else.
          // `errs` is safe for everyone: it names rows that were REJECTED, and
          // says nothing about how the accepted figures compare to system stock.
          text: `✓ Saved ${j.success} count${j.success === 1 ? '' : 's'} for "${active}"`
            + (isAdmin && j.applied ? ` · ${j.applied} applied to stock` : '')
            + (isAdmin && j.pending ? ` · ${j.pending} sent for variance approval` : '')
            + (errs.length ? ` · ${errs.length} skipped: ${errs.slice(0, 2).join(' | ')}` : ''),
        };
        setEntries({});
        setCases({});
        setLoose({});
        // Refresh both detail and the location summary
        await openLocation(active!);
        await reloadLocations();
        // RAISE THE FLASH LAST. openLocation() clears savedFlash — it is the
        // "entering an area" reset — so a flash set before this line was wiped
        // in the same tick and never reached the screen at all. The old
        // "✓ Saved N counts" message has been invisible on this path for that
        // reason; there is no point reporting applied/pending here unless the
        // banner is raised after the reload.
        setSavedFlash(flash);
        // Unchanged 4s auto-dismiss for a clean save. A 'warn' flash STAYS: it
        // now carries the server's reason a row was not applied, and a reason
        // that wipes itself after four seconds is the same as no reason at all.
        // It clears on the next save or when the area is left.
        if (!errs.length) setTimeout(() => setSavedFlash(null), 4000);
      }
    } finally { setSaving(false); }
  };

  /* Escape hatch on the per-location count screen (requirement 3). The row
     joins this session's list immediately so the count can be typed now; the
     SAVE is what makes it part of the department's set for good (the
     closing_stock arm of the ever-requested query). today_count / today_variance
     start null — there is no count yet, and this path never derives a variance,
     so nothing about the system figure leaks to a counter. */
  const addItemToLocation = (row: any) => {
    addExtraRow(row);
    setItems(prev => prev.some(i => String(i.id) === String(row.id))
      ? prev
      : [...prev, { ...(row as Item), today_count: null, today_variance: null }]);
  };

  // Detail view
  if (active) {
    return (
      <div className="p-6 space-y-4">
        <div className="flex items-center gap-3">
          <button onClick={() => { setActive(null); setItems([]); setEntries({}); }}
                  className="text-[#6B5744] hover:text-[#af4408] flex items-center gap-1 text-sm">
            <ChevronLeft size={16} /> Back to locations
          </button>
        </div>
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 flex items-center gap-3 flex-wrap">
          <MapPin className="text-[#af4408]" size={22} />
          <div className="flex-1">
            <div className="text-lg font-semibold text-[#2D1B0E]">{active}</div>
            <div className="text-xs text-[#8B7355]">
              Counting on <strong>{date}</strong> · {items.length} item{items.length === 1 ? '' : 's'} in this area
            </div>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-[#6B5744]">
            <input type="checkbox" checked={filterUncountedOnly} onChange={e => setFilterUncountedOnly(e.target.checked)} />
            Only show un-counted
          </label>
          {/* Admin-only — store managers must not be able to one-click clear a
              variance without an approver looking at it. The server forces the
              flag off for everyone else regardless, so hiding it here just
              matches. Unticked (the default) the count still only raises a
              pending variance, which stays the normal route for admins too. */}
          {isAdmin && (
            <label className="flex items-center gap-1.5 text-xs text-[#6B5744]" title="Admin-only: approve these counts' variances as you save, so system stock moves to the physical figure now instead of waiting in the approval queue. Central-store counts only — a department count never moves central stock.">
              <input type="checkbox" checked={adjustStock} onChange={e => setAdjustStock(e.target.checked)} />
              Adjust system stock to match
            </label>
          )}
          <button onClick={saveAll} disabled={saving || pendingEntries.length === 0}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#af4408] hover:bg-[#933807] text-white rounded text-sm disabled:opacity-40">
            {saving ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} />}
            Save {pendingEntries.length > 0 ? `(${pendingEntries.length})` : 'All'}
          </button>
        </div>

        {/* Amber = stock actually moved, red = the server could not do something,
            emerald = recorded and queued. Same palette as the modal, where amber
            is already "this touches system stock". */}
        {savedFlash && (
          <div className={`border rounded-xl px-4 py-2 text-sm flex items-start gap-2 ${
            savedFlash.tone === 'warn' ? 'bg-red-50 border-red-200 text-red-700'
              : savedFlash.tone === 'applied' ? 'bg-amber-50 border-amber-200 text-amber-800'
              : 'bg-emerald-50 border-emerald-200 text-emerald-800'}`}>
            {savedFlash.tone === 'warn' ? <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
              : savedFlash.tone === 'applied' ? <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
              : <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" />}
            {savedFlash.text}
          </div>
        )}

        {/* Requirement 4 — why this area lists what it lists, plus the way out
            when the section is holding something the list has never seen. */}
        {renderDeptScope(addItemToLocation)}

        {/* Search + category chips — narrow the count table when an area has
            many items (e.g. dry store with 200+ groceries). Counts on chips
            update live based on the search box. */}
        {items.length > 0 && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl px-4 py-3 space-y-2.5">
            <div className="flex items-center gap-2">
              <input type="text" value={itemSearch}
                     onChange={e => setItemSearch(e.target.value)}
                     placeholder="Search by item name or SKU…"
                     className="flex-1 px-3 py-1.5 border border-[#D4B896] rounded-lg bg-[#FFF8F0] text-sm" />
              {itemSearch && (
                <button onClick={() => setItemSearch('')}
                        className="text-xs text-[#af4408] hover:underline whitespace-nowrap">clear</button>
              )}
              <span className="text-xs text-[#8B7355] whitespace-nowrap">
                {visibleItems.length} of {items.length}
              </span>
            </div>
            {categoryCounts.length > 1 && (
              <TabScroller className="gap-1.5">
                <button onClick={() => setCategoryFilter('')}
                        className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                          !categoryFilter ? 'bg-[#af4408] text-white'
                                          : 'bg-[#FFF1E3] text-[#6B5744] hover:bg-[#F5EDE2]'}`}>
                  All <span className="opacity-70">({categoryCounts.reduce((s, c) => s + c.count, 0)})</span>
                </button>
                {categoryCounts.map(c => {
                  const active = categoryFilter === c.name;
                  return (
                    <button key={c.name}
                            onClick={() => setCategoryFilter(active ? '' : c.name)}
                            className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                              active ? 'bg-[#af4408] text-white'
                                     : 'bg-[#FFF1E3] text-[#6B5744] hover:bg-[#F5EDE2]'}`}>
                      {c.name} <span className="opacity-70">({c.count})</span>
                    </button>
                  );
                })}
              </TabScroller>
            )}
          </div>
        )}

        <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
          {itemsLoading ? (
            <div className="p-6 text-center text-sm text-[#8B7355]"><Loader2 className="animate-spin inline mr-1" size={14} /> Loading items…</div>
          ) : visibleItems.length === 0 ? (
            <div className="p-6 text-center text-sm text-[#8B7355]">No items match.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-[#FFF1E3] text-[#6B5744]">
                  <tr>
                    <th className="text-left  py-2 px-3 font-medium">Material</th>
                    <th className="text-left  py-2 px-3 font-medium">Category</th>
                    {/* Blind count: only admins see the system number + variance, so
                        staff can't just type back the expected figure to hide a loss. */}
                    {isAdmin && <th className="text-right py-2 px-3 font-medium">System</th>}
                    <th className="text-left  py-2 px-3 font-medium w-[280px]">Physical count <span className="font-normal text-[9px] text-[#8B7355]">(packs + loose)</span></th>
                    {isAdmin && <th className="text-right py-2 px-3 font-medium">Variance</th>}
                    <th className="text-left  py-2 px-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.map(it => {
                    // Every figure in this row LEADS in the purchase unit (the
                    // unit the counter is holding); the recipe number follows as
                    // the small grey hint. Stored values are untouched — the
                    // recipe qty is what physicalFor() posts.
                    const puUnit = it.purchase_unit || it.unit;
                    // Only rendered inside the admin-only System column; coerce the
                    // (blind-count) null to 0 so the type is happy.
                    const sysStock = it.current_stock ?? 0;
                    const sysDisplay = `${fmtQtyNum(toPurchaseQty(sysStock, it))} ${puUnit}`;
                    const todayDisplay = it.today_count != null
                      ? `${fmtQtyNum(toPurchaseQty(it.today_count, it))} ${puUnit}`
                      : null;
                    const isLow = it.current_stock != null && it.current_stock < (it.reorder_level || 0);
                    const cadenceTag = it.closing_cadence && !['monthly', 'none', ''].includes(String(it.closing_cadence).toLowerCase());
                    return (
                      <tr key={it.id} className={`border-t border-[#E8D5C4]/50 ${isLow ? 'bg-red-50/30' : ''}`}>
                        <td className="py-1.5 px-3">
                          <div className="font-medium text-[#2D1B0E]">{it.name}</div>
                          <div className="flex gap-1.5 mt-0.5 items-center">
                            <span className="text-[10px] font-mono text-[#8B7355]">{it.sku || '·'}</span>
                            {cadenceTag && (
                              <span className="text-[9px] px-1 py-0.5 rounded bg-[#FFF1E3] text-[#6B5744] uppercase">{it.closing_cadence}</span>
                            )}
                            {isLow && <span className="text-[9px] px-1 py-0.5 rounded bg-red-100 text-red-700">low</span>}
                          </div>
                        </td>
                        <td className="py-1.5 px-3 text-[10px] text-[#6B5744]">
                          {it.super_category || it.category || '—'}
                        </td>
                        {isAdmin && (
                          <td className="py-1.5 px-3 text-right font-mono">
                            {sysDisplay}
                            {hintLine(sysStock, it) && (
                              <span className="block text-[9px] text-[#B8A590]">{hintLine(sysStock, it)}</span>
                            )}
                          </td>
                        )}
                        <td className="py-1.5 px-3">
                          {(() => {
                            const packSize = packFactor(it); // guarded: 1 when unit ≡ purchase_unit
                            const caseSize = it.case_size && it.case_size > 1 ? it.case_size : 1;
                            const showCases = caseSize > 1;   // outer case of bottles
                            const showLoose = packSize > 1;   // open/partial bottle (ml/g)
                            const box = "w-12 px-1 py-1 border border-[#D4B896] rounded text-xs text-right font-mono bg-white focus:outline-none focus:ring-1 focus:ring-[#af4408]";
                            // Simple item — no case, no pack conversion, so the
                            // purchase unit and the recipe unit are the SAME
                            // number. One box, labelled with the purchase unit
                            // (what the counter reads), no hint to repeat.
                            if (!showCases && !showLoose) {
                              const simpleUnit = it.purchase_unit || it.unit;
                              return (
                                <div className="flex items-center gap-1">
                                  <input type="number" step="any" min={0}
                                         value={entries[it.id] ?? (it.today_count != null ? String(it.today_count) : '')}
                                         onChange={e => setEntries(p => ({ ...p, [it.id]: e.target.value }))}
                                         placeholder={`count in ${simpleUnit}`}
                                         className="w-32 px-2 py-1 border border-[#D4B896] rounded text-xs text-right font-mono bg-white focus:outline-none focus:ring-1 focus:ring-[#af4408]" />
                                  <span className="text-[10px] text-[#8B7355]">{simpleUnit}</span>
                                </div>
                              );
                            }
                            const total = physicalFor(it, cases[it.id], entries[it.id], loose[it.id]);
                            return (
                              <div className="flex items-center gap-1 flex-wrap">
                                {showCases && (<>
                                  <input type="number" step="any" min={0} value={cases[it.id] ?? ''}
                                         onChange={e => setCases(p => ({ ...p, [it.id]: e.target.value }))}
                                         placeholder="0"
                                         title={`Full cases — 1 case = ${caseSize} ${it.purchase_unit || 'unit'} = ${caseSize * packSize} ${it.unit}`}
                                         className={box} />
                                  <span className="text-[10px] text-[#8B7355]">case</span>
                                  <span className="text-[10px] text-[#8B7355]">+</span>
                                </>)}
                                <input type="number" step="any" min={0} value={entries[it.id] ?? ''}
                                       onChange={e => setEntries(p => ({ ...p, [it.id]: e.target.value }))}
                                       placeholder="0"
                                       title={`${it.purchase_unit || 'unit'} — 1 = ${packSize} ${it.unit}`}
                                       className={box} />
                                <span className="text-[10px] text-[#8B7355]">{it.purchase_unit || it.unit}</span>
                                {showLoose && (<>
                                  <span className="text-[10px] text-[#8B7355]">+</span>
                                  <input type="number" step="any" min={0} value={loose[it.id] ?? ''}
                                         onChange={e => setLoose(p => ({ ...p, [it.id]: e.target.value }))}
                                         placeholder="0"
                                         title={`Loose / open ${it.unit}`}
                                         className={box} />
                                  <span className="text-[10px] text-[#8B7355]">{it.unit}</span>
                                </>)}
                                {total != null && (
                                  // Running total LEADS in the purchase unit —
                                  // this cell used to print only the recipe
                                  // figure, so typing "2 BTL" answered "1500 ml".
                                  // `total` itself stays recipe (it is what
                                  // saveAll posts).
                                  <span className="font-mono text-[#af4408] whitespace-nowrap">
                                    <span className="text-[10px]">= {fmtQtyNum(toPurchaseQty(total, it))} {it.purchase_unit || it.unit}</span>
                                    {hintLine(total, it) && (
                                      <span className="block text-[9px] text-[#B8A590]">{hintLine(total, it)}</span>
                                    )}
                                  </span>
                                )}
                              </div>
                            );
                          })()}
                        </td>
                        {isAdmin && (
                          <td className="py-1.5 px-3 text-right font-mono">
                            {(() => {
                              const phys = physicalFor(it, cases[it.id], entries[it.id], loose[it.id]) ?? it.today_count;
                              if (phys == null || it.current_stock == null) return <span className="text-[#8B7355]">—</span>;
                              const vRecipe = phys - it.current_stock;
                              const v = toPurchaseQty(vRecipe, it);
                              const tone = v < 0 ? 'text-amber-800' : v > 0 ? 'text-blue-800' : 'text-emerald-700';
                              return (
                                <span className={tone}>
                                  {v > 0 ? '+' : ''}{fmtQtyNum(v)} {it.purchase_unit || it.unit}
                                  {packFactor(it) > 1 && (
                                    <span className="block text-[9px] text-[#B8A590]">
                                      = {vRecipe > 0 ? '+' : ''}{fmtQtyNum(vRecipe)} {it.unit}
                                    </span>
                                  )}
                                </span>
                              );
                            })()}
                          </td>
                        )}
                        <td className="py-1.5 px-3">
                          {it.today_count != null ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700"
                                  title={[it.today_by ? `By ${it.today_by}` : '', hintLine(it.today_count, it) || '']
                                    .filter(Boolean).join(' · ')}>
                              ✓ counted: {todayDisplay}
                            </span>
                          ) : (cases[it.id] || entries[it.id] || loose[it.id]) ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">↻ unsaved</span>
                          ) : (
                            <span className="text-[10px] text-[#8B7355]">pending</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Locations grid view
  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-3">
        <MapPin className="text-[#af4408]" size={24} />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-[#2D1B0E]">Closing Stock by Location</h1>
          <p className="text-xs text-[#8B7355]">
            Pick a storage area, count the items there, save in one go. Set <code>storage_location</code> per material via{' '}
            <a href="/inventory" className="text-[#af4408] underline">Raw Materials</a>.
          </p>
        </div>
        <button
          onClick={openClosingStock}
          className="flex items-center gap-2 px-4 py-2.5 border border-green-600 text-green-700 hover:bg-green-50 rounded-lg text-sm font-medium transition-colors"
        >
          <ClipboardCheck className="w-4 h-4" />
          Update / Record Closing Stock
        </button>
        <label className="text-xs text-[#6B5744] flex flex-col gap-1">
          Date
          {/* This is a COUNT date, not just a view filter — saveAll() posts it as
              the closing_stock date (see the POST at ~:1477). Capped at today IST
              because a future date (a 2027 typo) becomes the NEWEST count for those
              materials and then silently refuses every real count until someone
              rejects it — only the newest-dated count per item is approvable.
              max= is a HINT ONLY: it is bypassed by typing and ignored by some
              mobile browsers, so /api/closing-stock stays the real guard. Called
              per render, never hoisted to module scope, so a tab left open
              overnight does not keep yesterday as the ceiling. */}
          <input type="date" value={date} onChange={e => setDate(e.target.value)} max={todayIST()}
                 className="px-2 py-1.5 border border-[#D4B896] rounded text-sm" />
        </label>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4">
          <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Locations</div>
          <div className="text-2xl font-semibold text-[#2D1B0E] mt-1">{totals.locations}</div>
        </div>
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4">
          <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Total items</div>
          <div className="text-2xl font-semibold text-[#2D1B0E] mt-1">{totals.items}</div>
        </div>
        <div className="bg-white border border-emerald-200 rounded-xl p-4">
          <div className="text-[10px] uppercase tracking-wide text-emerald-700">Counted today</div>
          <div className="text-2xl font-semibold text-emerald-800 mt-1">
            {totals.counted}
            <span className="text-sm font-normal text-[#8B7355]"> / {totals.items}</span>
          </div>
        </div>
      </div>

      {/* Department scope — who's count is being viewed/recorded. Admin / Manager /
          HOD / Store Manager may pick any department (or the store/overall bucket);
          a user with granted visible departments picks among that subset; a plain
          department user is pinned to their own department (amber banner). */}
      {hasDeptChoice ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl px-4 py-3 flex items-center gap-3 flex-wrap">
          <span className="text-xs font-medium text-[#6B5744]">Counting for department</span>
          <select value={selectedDept} onChange={e => setSelectedDept(e.target.value)}
                  className="px-2 py-1.5 border border-[#D4B896] rounded text-sm bg-white">
            {(canSeeAllDepts || !ownDeptId) && <option value="">— Store / Overall —</option>}
            {pickableDepts.map(d => (
              <option key={d.id} value={d.id}>
                {d.name}{d.area ? ` · ${AREA_LABELS[d.area] || d.area}` : ''}
              </option>
            ))}
          </select>
          <span className="text-[10px] text-[#8B7355]">
            {canSeeAllDepts
              ? 'Counts you save below are recorded against this department.'
              : 'You may record for your granted departments. Counts you save below are recorded against the selected one.'}
          </span>
        </div>
      ) : tierBanner}

      {/* Requirement 4 — the count that makes the scoping visible. The board is
          a summary, not an entry screen, so no escape hatch here: it lives on
          the two surfaces where a count is actually typed. */}
      {renderDeptScope()}

      {/* Per-area rollup — admin/HOD view of each area's overall closing value. */}
      {canSeeAllDepts && byArea.length > 0 && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4">
          <div className="text-xs font-semibold text-[#2D1B0E] mb-2">Area rollup — physical closing value ({date})</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {byArea.map((a: any) => (
              <div key={a.area} className="border border-[#E8D5C4] rounded-lg p-3 bg-[#FFF8F0]">
                <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">{AREA_LABELS[a.area] || a.area}</div>
                <div className="text-lg font-semibold text-[#2D1B0E] mt-1">{fmt(a.physical_value)}</div>
                <div className="text-[10px] text-[#8B7355] mt-0.5">{a.item_count} item{a.item_count === 1 ? '' : 's'}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="p-10 text-center text-sm text-[#8B7355]"><Loader2 className="animate-spin inline mr-1" size={14} /> Loading locations…</div>
      ) : locations.length === 0 ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center text-sm text-[#8B7355]">
          No materials found. Make sure storage locations are set on the inventory page.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {locations.map(l => {
            const pct = l.items > 0 ? Math.round((l.counted_today / l.items) * 100) : 0;
            const done = l.items > 0 && l.counted_today === l.items;
            return (
              <button key={l.location} onClick={() => openLocation(l.location)}
                      className={`text-left bg-white border rounded-xl p-4 hover:border-[#af4408] hover:shadow transition ${done ? 'border-emerald-300' : 'border-[#E8D5C4]'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <Package size={16} className="text-[#af4408] shrink-0" />
                    <div className="font-semibold text-[#2D1B0E] truncate">{l.location}</div>
                  </div>
                  {done && <CheckCircle2 size={18} className="text-emerald-600 shrink-0" />}
                </div>
                <div className="mt-3 flex items-center gap-2 text-xs text-[#6B5744]">
                  <span><strong className="text-[#2D1B0E]">{l.items}</strong> items</span>
                  <span className="text-[#D4B896]">·</span>
                  <span className="text-emerald-700">{l.counted_today} counted</span>
                  {l.low_stock > 0 && <>
                    <span className="text-[#D4B896]">·</span>
                    <span className="text-red-700">{l.low_stock} low</span>
                  </>}
                </div>
                <div className="mt-2 h-1.5 bg-[#FFF1E3] rounded-full overflow-hidden">
                  <div className={`h-full transition-all ${done ? 'bg-emerald-500' : 'bg-[#af4408]'}`}
                       style={{ width: `${pct}%` }} />
                </div>
                <div className="mt-1 text-[10px] text-[#8B7355]">{pct}% complete</div>
              </button>
            );
          })}
        </div>
      )}
      {/* ================================================================ */}
      {/* CLOSING STOCK MODAL (moved from Raw Materials page)              */}
      {/* ================================================================ */}
      {closingStockOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-4 pb-4 overflow-y-auto">
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setClosingStockOpen(false)} />
          <div className="relative w-full max-w-6xl bg-white rounded-2xl shadow-xl border border-[#E8D5C4] mx-4 my-4">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4] sticky top-0 bg-white rounded-t-2xl z-20">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-100">
                  <ClipboardCheck className="w-5 h-5 text-green-600" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-[#2D1B0E]">Record Closing Stock</h2>
                  <p className="text-xs text-[#8B7355]">
                    Enter physical count for each material — in the <strong>purchase unit</strong> shown in the Unit column
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap justify-end">
                {!showHistory && (
                  <>
                    {/* Download a template pre-filled with current stock, count
                        offline in Excel, then upload the filled file back. */}
                    <button
                      onClick={downloadClosingTemplate}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-[#FFF1E3] text-[#6B5744] hover:bg-[#E8D5C4] inline-flex items-center gap-1"
                      title="Download a CSV of current stock with a blank Physical count column"
                    >
                      <Download className="w-3.5 h-3.5" /> Template
                    </button>
                    <label
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-[#FFF1E3] text-[#6B5744] hover:bg-[#E8D5C4] inline-flex items-center gap-1 cursor-pointer"
                      title="Upload the filled CSV to record physical counts in bulk"
                    >
                      <Upload className="w-3.5 h-3.5" /> Upload CSV
                      <input
                        type="file" accept=".csv,text/csv" className="hidden"
                        onChange={e => { const f = e.target.files?.[0]; if (f) uploadClosingCsv(f); e.target.value = ''; }}
                      />
                    </label>
                  </>
                )}
                <button
                  onClick={() => setShowHistory(!showHistory)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${showHistory ? 'bg-purple-100 text-purple-700' : 'bg-[#FFF1E3] text-[#6B5744] hover:bg-[#E8D5C4]'}`}
                >
                  {showHistory ? 'Back to Entry' : 'View History'}
                </button>
                <button onClick={() => setClosingStockOpen(false)} className="p-1 text-[#8B7355] hover:text-[#2D1B0E]"><X className="w-5 h-5" /></button>
              </div>
            </div>

            {showHistory ? (
              /* History View */
              <div className="px-6 py-5 space-y-4">
                {closingHistory.length === 0 ? (
                  <div className="text-center py-12 text-[#8B7355]">
                    <ClipboardCheck className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p>No closing stock records found</p>
                  </div>
                ) : !historyDate ? (
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold text-[#2D1B0E]">Closing Stock Records</h3>
                    {closingHistory.map((h: any) => (
                      <div
                        key={h.date}
                        onClick={() => viewHistoryDate(h.date)}
                        className="bg-white border border-[#E8D5C4] rounded-lg p-4 cursor-pointer hover:shadow-md transition-shadow"
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="font-semibold text-[#2D1B0E]">{new Date(h.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })}</p>
                            <p className="text-xs text-[#8B7355]">
                              {h.item_count} items recorded
                              {h.semi_count > 0 && <> · {h.semi_count} semi-finished</>}
                              {h.unvalued_count > 0 && (
                                <span title="Counts saved before closing stock was valued — they carry no stored rate, so the day's value below is partial.">
                                  {' '}· {h.unvalued_count} unvalued
                                </span>
                              )}
                            </p>
                          </div>
                          <div className="flex items-center gap-4 text-xs">
                            {/* Closing VALUE is cost data, not variance data, so
                                every tier sees it (req 4). Shown only when the
                                server sends it. */}
                            {h.total_value != null && (
                              <span className="text-[#2D1B0E]">Value: <span className="font-semibold font-mono">{fmtMoney(h.total_value)}</span></span>
                            )}
                            {isAdmin && h.shortage_count > 0 && (
                              <span className="flex items-center gap-1 text-red-500"><TrendingDown className="w-3 h-3" />{h.shortage_count} shortage</span>
                            )}
                            {isAdmin && h.excess_count > 0 && (
                              <span className="flex items-center gap-1 text-blue-500"><TrendingUp className="w-3 h-3" />{h.excess_count} excess</span>
                            )}
                            {isAdmin && <span className="text-[#af4408] font-semibold">Variance: {formatCurrency(h.total_variance_value)}</span>}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : historyLoading ? (
                  <div className="text-center py-12"><Loader2 className="w-8 h-8 text-[#af4408] animate-spin mx-auto" /></div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <button onClick={() => setHistoryDate(null)} className="text-xs text-[#af4408] hover:underline mb-1">&larr; Back to dates</button>
                        <h3 className="text-sm font-semibold text-[#2D1B0E]">
                          Closing Stock — {new Date(historyDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })}
                        </h3>
                        {/* Download the sheet exactly as recorded on this date.
                            Sits under the heading it belongs to, so it can only
                            ever mean "this date" — the date list behind it has
                            no download, because a count is read one day at a
                            time. Carries the same admin gating as the table:
                            a non-admin's file has no System Stock or Variance
                            column at all. */}
                        <button
                          onClick={downloadHistoryCsv}
                          disabled={!historyItems.length && !historySemi.length}
                          title={`Download the ${historyItems.length + historySemi.length} recorded row(s) for this date as CSV`}
                          className="mt-1.5 inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-[#FFF1E3] text-[#6B5744] hover:bg-[#E8D5C4] disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Download className="w-3.5 h-3.5" /> Download CSV
                        </button>
                      </div>
                      {historySummary && (
                        <div className="flex gap-4 text-xs">
                          <span className="text-[#6B5744]">Items: <span className="font-bold">{historySummary.total_items}</span></span>
                          {historySemi.length > 0 && (
                            <span className="text-[#6B5744]">Semi-finished: <span className="font-bold">{historySemi.length}</span></span>
                          )}
                          {historyPriced && (
                            <span className="text-[#2D1B0E]">Closing value: <span className="font-bold font-mono">{fmtMoney(historyValueTotal)}</span></span>
                          )}
                          {isAdmin && <span className="text-red-500">Shortage: <span className="font-bold">{historySummary.shortage_count}</span></span>}
                          {isAdmin && <span className="text-blue-500">Excess: <span className="font-bold">{historySummary.excess_count}</span></span>}
                          {isAdmin && <span className="text-[#af4408]">Variance Value: <span className="font-bold">{formatCurrency(Math.abs(historySummary.total_variance_value))}</span></span>}
                        </div>
                      )}
                    </div>
                    <div className="overflow-x-auto max-h-[60vh] overflow-y-auto rounded-lg border border-[#E8D5C4]">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-[#FFF1E3] z-10">
                          <tr className="text-[#8B7355]">
                            <th className="text-left py-2.5 px-3 font-medium">Material</th>
                            <th className="text-left py-2.5 px-3 font-medium">Category</th>
                            {/* Blind count: System / Variance columns are admin-only. */}
                            {isAdmin && <th className="text-right py-2.5 px-3 font-medium">System Stock</th>}
                            <th className="text-right py-2.5 px-3 font-medium">Physical Stock</th>
                            {/* Valued history (req 4). Rate + value are COST data,
                                not variance data, so they are NOT admin-gated —
                                and neither of them can be used to back out the
                                system figure. Both are the STORED ones. */}
                            <th className="text-right py-2.5 px-3 font-medium">
                              Last Purchase Price
                              <span className="block font-normal text-[9px] text-[#8B7355]">at count time, per purchase unit</span>
                            </th>
                            <th className="text-right py-2.5 px-3 font-medium">Total Value</th>
                            {isAdmin && <th className="text-right py-2.5 px-3 font-medium">Variance</th>}
                            {isAdmin && <th className="text-right py-2.5 px-3 font-medium">Variance (₹)</th>}
                            <th className="text-left py-2.5 px-3 font-medium">Notes</th>
                          </tr>
                        </thead>
                        <tbody>
                          {historyItems.map((item: any) => {
                            const isShortage = item.variance < 0;
                            const isExcess = item.variance > 0;
                            // API rows now carry purchase_unit/pack_size; render the
                            // stored recipe numbers on the purchase basis (display only).
                            const hm = { unit: item.unit, purchase_unit: item.purchase_unit, pack_size: item.pack_size };
                            const hpf = packFactor(hm);
                            const hq = (v: number) => fmtQtyNum(toPurchaseQty(Number(v) || 0, hm));
                            const hu = item.purchase_unit || item.unit;
                            /** The recipe figure under a purchase one — only when it converts. */
                            const hh = (v: number, sign = false) => hpf > 1 ? (
                              <span className="block text-[9px] font-normal text-[#B8A590]">
                                = {sign && Number(v) > 0 ? '+' : ''}{fmtQtyNum(Number(v) || 0)} {item.unit}
                              </span>
                            ) : null;
                            return (
                              <tr key={item.id} className={`border-t border-[#E8D5C4]/50 ${isAdmin && isShortage ? 'bg-red-50/50' : isAdmin && isExcess ? 'bg-blue-50/50' : ''}`}>
                                <td className="py-2 px-3 text-[#2D1B0E] font-medium text-xs">{item.material_name}</td>
                                <td className="py-2 px-3 text-xs text-[#6B5744]">{categoryLabel(item.category)}</td>
                                {isAdmin && (
                                  <td className="py-2 px-3 text-right text-xs font-mono">
                                    {hq(item.system_stock)} {hu}
                                    {hh(item.system_stock)}
                                  </td>
                                )}
                                <td className="py-2 px-3 text-right text-xs font-mono font-semibold">
                                  {hq(item.physical_stock)} {hu}
                                  {hh(item.physical_stock)}
                                </td>
                                {/* The rate STORED with this count, in ₹ per
                                    purchase unit — so it pairs with the purchase
                                    quantity in the cell to its left. */}
                                <td className="py-2 px-3 text-right text-xs">
                                  <RateCell rate={item.rate_per_purchase_unit} source={item.rate_source} asOf={item.rate_as_of} purchaseUnit={hu} stored={item.rate_is_stored} />
                                </td>
                                <td className="py-2 px-3 text-right text-xs">
                                  <ValueCell value={item.total_value} source={item.rate_source} rate={item.rate_per_purchase_unit} />
                                </td>
                                {isAdmin && (
                                  <td className={`py-2 px-3 text-right text-xs font-mono font-semibold ${isShortage ? 'text-red-500' : isExcess ? 'text-blue-500' : 'text-green-600'}`}>
                                    {item.variance > 0 ? '+' : ''}{hq(item.variance)} {hu}
                                    {hh(item.variance, true)}
                                  </td>
                                )}
                                {isAdmin && (
                                  <td className={`py-2 px-3 text-right text-xs font-mono ${isShortage ? 'text-red-500' : isExcess ? 'text-blue-500' : 'text-green-600'}`}>
                                    {item.variance_value > 0 ? '+' : ''}{formatCurrency(item.variance_value)}
                                  </td>
                                )}
                                <td className="py-2 px-3 text-xs text-[#8B7355]">{item.notes || '-'}</td>
                              </tr>
                            );
                          })}

                          {/* Semi-finished counts for this date (req 1 + 4).
                              Valued by cost_per_unit in the sub-recipe's own
                              yield unit — no purchase unit, no pack factor. */}
                          {historySemi.length > 0 && (
                            <tr className="border-t-2 border-[#D4B896] bg-[#F5EDE2]">
                              <td colSpan={isAdmin ? 9 : 6} className="py-2 px-3">
                                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#6B5744]">
                                  <Layers className="w-3.5 h-3.5" /> Semi-finished / sub-recipes
                                  <span className="font-normal normal-case text-[10px] text-[#8B7355]">— counted and costed per yield unit</span>
                                </span>
                              </td>
                            </tr>
                          )}
                          {historySemi.map((s: any) => (
                            <tr key={`hs-${s.id}`} className="border-t border-[#E8D5C4]/50 bg-[#FFFDF9]">
                              <td className="py-2 px-3 text-[#2D1B0E] font-medium text-xs">{s.name}</td>
                              <td className="py-2 px-3 text-xs text-[#6B5744]">{categoryLabel(s.category || 'sub-recipe')}</td>
                              {isAdmin && <td className="py-2 px-3 text-right text-xs"><NoBasisDash what="system-stock" /></td>}
                              {/* unit-lock: a sub-recipe has no purchase unit — its yield
                                  unit IS the counting basis, so there is nothing to convert
                                  and no recipe hint to print. */}
                              <td className="py-2 px-3 text-right text-xs font-mono font-semibold">
                                {fmtQtyNum(Number(s.physical_stock) || 0)} {s.unit || s.yield_unit}
                              </td>
                              <td className="py-2 px-3 text-right text-xs">
                                <RateCell rate={s.rate_per_unit} source={s.rate_source} purchaseUnit={s.unit || s.yield_unit} stored={s.rate_is_stored} />
                              </td>
                              <td className="py-2 px-3 text-right text-xs">
                                <ValueCell value={s.total_value} source={s.rate_source} rate={s.rate_per_unit} />
                              </td>
                              {isAdmin && <td className="py-2 px-3 text-right text-xs"><NoBasisDash what="variance" /></td>}
                              {isAdmin && <td className="py-2 px-3 text-right text-xs"><NoBasisDash what="variance" /></td>}
                              <td className="py-2 px-3 text-xs text-[#8B7355]">{s.notes || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                        {/* SHEET TOTAL (req 4). Rupees add across materials;
                            quantities and per-unit rates do not — those print an
                            em-dash rather than a meaningless sum. */}
                        <tfoot className="sticky bottom-0 bg-[#FFF1E3] text-xs font-semibold text-[#2D1B0E]">
                          <tr className="border-t-2 border-[#D4B896]">
                            <td colSpan={isAdmin ? 3 : 2} className="py-2 px-3">
                              Sheet total
                              {historyUnvalued > 0 && (
                                <span className="ml-2 font-normal text-[10px] text-[#8B7355]">
                                  {historyUnvalued} item(s) had no price basis and are excluded
                                </span>
                              )}
                            </td>
                            <td className="py-2 px-3 text-right"><CrossDash what="quantity total" /></td>
                            <td className="py-2 px-3 text-right"><CrossDash what="rate total" /></td>
                            <td className="py-2 px-3 text-right font-mono">
                              {historyPriced ? fmtMoney(historyValueTotal) : <NoBasisDash />}
                            </td>
                            {isAdmin && <td className="py-2 px-3 text-right"><CrossDash what="quantity total" /></td>}
                            {isAdmin && (
                              <td className="py-2 px-3 text-right font-mono">
                                {formatCurrency(historyItems.reduce((s: number, i: any) => s + (Number(i.variance_value) || 0), 0))}
                              </td>
                            )}
                            <td className="py-2 px-3" />
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                    {!historyPriced && (
                      <p className="text-[11px] italic text-[#8B7355]">
                        No stored valuation for this date — these counts were recorded before closing stock was valued. Historical rows are never re-priced from today&apos;s rates.
                      </p>
                    )}
                  </div>
                )}
              </div>
            ) : (
              /* Entry View */
              <div className="px-6 py-5 space-y-4">
                {/* Date & Options — wrap so the 5 controls never overflow or
                    overlap on narrow/tablet widths (they stack/wrap instead). */}
                <div className="flex flex-wrap gap-4 items-end">
                  <div>
                    <label className="block text-xs font-medium text-[#6B5744] mb-1">Closing Date *</label>
                    {/* Capped at today IST for the same reason as the grid-header
                        date above: a future count freezes the baseline and blocks
                        every later real count for those items. Backdating stays
                        open — only the future is refused. max= is a hint; the
                        submit still goes through the server guard (this one date
                        feeds BOTH /api/closing-stock and …/closing-stock/semi). */}
                    <input
                      type="date"
                      value={closingDate}
                      onChange={e => setClosingDate(e.target.value)}
                      max={todayIST()}
                      className="px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408] [color-scheme:light]"
                    />
                  </div>
                  {/* Department scope — same selection as the grid header. Admin /
                      HOD pick any department; visible-dept users pick among their
                      granted subset; pinned users are shown read-only. */}
                  <div>
                    <label className="block text-xs font-medium text-[#6B5744] mb-1">Department</label>
                    {hasDeptChoice ? (
                      <select
                        value={selectedDept}
                        onChange={e => setSelectedDept(e.target.value)}
                        className="px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408]"
                      >
                        {(canSeeAllDepts || !ownDeptId) && <option value="">Store / Overall</option>}
                        {pickableDepts.map(d => (
                          <option key={d.id} value={d.id}>
                            {d.name}{d.area ? ` · ${AREA_LABELS[d.area] || d.area}` : ''}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#6B5744]">
                        {ownDeptName}
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-[180px]">
                    <label className="block text-xs font-medium text-[#6B5744] mb-1">Search Material</label>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
                      <input
                        type="text"
                        value={closingSearch}
                        onChange={e => setClosingSearch(e.target.value)}
                        placeholder="Filter by name..."
                        className="w-full pl-10 pr-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] placeholder-[#8B7355] focus:outline-none focus:ring-2 focus:ring-[#af4408]"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#6B5744] mb-1">Category</label>
                    <select
                      value={closingCategory}
                      onChange={e => setClosingCategory(e.target.value)}
                      className="px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408]"
                    >
                      <option value="">All Categories</option>
                      {categoryGroups.map(g => (
                        <optgroup key={g.sup} label={g.sup}>
                          {g.cats.map(c => <option key={c} value={c}>{categoryLabel(c)}</option>)}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                  {/* Only admins may clear a count's variance as they save it.
                      The server still computes `isAdmin && adjust_stock === true`
                      and forces the flag false for everyone else (see
                      /api/closing-stock POST), so hiding it here just matches —
                      it is not the gate. Leaving it unticked is the default for
                      admins too, and keeps the count on the approval queue. */}
                  {isAdmin && (
                    <label className="flex items-center gap-2 cursor-pointer bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                      <input type="checkbox" checked={adjustStockModal} onChange={e => setAdjustStockModal(e.target.checked)} className="accent-[#af4408] w-4 h-4" />
                      <span className="text-xs text-amber-800 font-medium whitespace-nowrap">Adjust system stock</span>
                    </label>
                  )}
                </div>

                {/* Effective-tier banner — only when the dept picker is hidden. */}
                {tierBanner}

                {/* Requirement 4 — "40 items this department uses", plus the
                    escape hatch for the first time it holds something new. */}
                {renderDeptScope(addExtraRow)}

                {/* Subtle fallback note — the active department has no category
                    whitelist configured, so the full material list is shown.
                    Silent once the ever-requested scope is in force: the sheet
                    is then scoped by requisition history, not by category, and
                    the banner above already says so. */}
                {activeDeptId && departments.length > 0 && !deptCategorySet && !deptScopeActive && (
                  <p className="text-[11px] italic text-[#8B7355]">
                    No category filter is set for{' '}
                    {departments.find((d: any) => d.id === activeDeptId)?.name || 'this department'}
                    {' '}— showing all materials.
                  </p>
                )}

                {/* WHAT THE TICK ACTUALLY DOES, told in two halves, because the
                    old one-liner ("System stock will be updated to match physical
                    counts") was true for a central count and flatly wrong for a
                    department one. The server carves department rows out: saving
                    the count already re-anchors that department's own balance, so
                    approving it too would take the difference off twice. Say which
                    half the admin is on right now — activeDeptId is exactly the
                    department_id this sheet will POST — instead of making them
                    work it out from the picker. */}
                {adjustStockModal && (
                  <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-xs">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    {activeDeptId ? (
                      <span>
                        You are counting for{' '}
                        <strong>{departments.find(d => d.id === activeDeptId)?.name || 'a department'}</strong>,
                        so this tick will not move anything. A department count updates that
                        department&apos;s own balance and never touches central store stock — its
                        variance is still listed in the approval queue, but only to be cleared
                        there, not posted: the count has already re-anchored this department, so
                        approving it would take the difference off twice. Switch the sheet to the
                        store to adjust central stock.
                      </span>
                    ) : (
                      <span>
                        On save, each central-store variance is approved straight away in your name:
                        system stock moves to the counted figure and the difference is logged as an
                        inventory adjustment — no separate approval step. Leave this unticked and the
                        counts are still recorded, but the variances wait for an approver.
                      </span>
                    )}
                  </div>
                )}

                {/* Materials Table */}
                <div className="overflow-x-auto max-h-[55vh] overflow-y-auto rounded-lg border border-[#E8D5C4]">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-[#FFF1E3] z-10">
                      <tr className="text-[#8B7355]">
                        <th className="text-left py-2.5 px-3 font-medium">Material</th>
                        <th className="text-left py-2.5 px-3 font-medium">Category</th>
                        {/* Blind count: only admins see the expected figure + variance —
                            a counter who can read the system number can copy it back. */}
                        {isAdmin && <th className="text-right py-2.5 px-3 font-medium">System Stock</th>}
                        <th className="text-right py-2.5 px-3 font-medium">Unit</th>
                        <th className="text-right py-2.5 px-3 font-medium w-32">
                          Physical Count *
                          <span className="block font-normal text-[9px] text-[#8B7355]">in purchase units</span>
                        </th>
                        {isAdmin && <th className="text-right py-2.5 px-3 font-medium">Variance</th>}
                        <th className="text-left py-2.5 px-3 font-medium w-40">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {closingFiltered.map((m) => {
                        const ci = closingItems[m.id];
                        // Counts are ENTERED in the purchase unit (owner rule: the
                        // person counting sees bottles/kg, not ml/g). System stock
                        // and variance render on the same basis; the recipe number
                        // only leaves this component ×packFactor at submit.
                        const pf = packFactor(m);
                        const sysPU = m.current_stock == null ? null : toPurchaseQty(m.current_stock, m);
                        const physicalVal = ci ? parseFloat(ci.physical_stock) : NaN;
                        // Variance is computed in the PURCHASE basis (both sides
                        // are purchase figures); the recipe hint is ×pf of it.
                        const variance = !isNaN(physicalVal) && sysPU != null ? Math.round((physicalVal - sysPU) * 1000) / 1000 : null;
                        const isShortage = variance !== null && variance < 0;
                        const isExcess = variance !== null && variance > 0;
                        return (
                          <tr key={m.id} className={`border-t border-[#E8D5C4]/50 ${isShortage ? 'bg-red-50/30' : isExcess ? 'bg-blue-50/30' : ''}`}>
                            <td className="py-1.5 px-3 text-[#2D1B0E] font-medium text-xs">{m.name}</td>
                            <td className="py-1.5 px-3">
                              <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${CATEGORY_COLORS[m.category]?.bg || ''} ${CATEGORY_COLORS[m.category]?.text || ''}`}>
                                {categoryLabel(m.category)}
                              </span>
                            </td>
                            {isAdmin && (
                              <td className="py-1.5 px-3 text-right text-xs font-mono text-[#2D1B0E]">
                                {sysPU == null ? '' : fmtQtyNum(sysPU)}
                                {sysPU != null && hintLine(m.current_stock, m) && (
                                  <span className="block text-[9px] text-[#B8A590]">{hintLine(m.current_stock, m)}</span>
                                )}
                              </td>
                            )}
                            <td className="py-1.5 px-3 text-right text-xs text-[#8B7355]" title={pf > 1 ? `1 ${m.purchase_unit} = ${pf} ${m.unit}` : undefined}>{m.purchase_unit || m.unit}</td>
                            <td className="py-1.5 px-2">
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={ci?.physical_stock || ''}
                                onChange={e => updateClosingItem(m.id, 'physical_stock', e.target.value)}
                                placeholder={isAdmin && sysPU != null ? sysPU.toString() : ''}
                                className="w-full px-2 py-1 bg-white border border-[#D4B896] rounded text-xs text-right font-mono text-[#2D1B0E] focus:outline-none focus:ring-1 focus:ring-[#af4408] placeholder-[#C4B09A]"
                              />
                            </td>
                            {isAdmin && <td className={`py-1.5 px-3 text-right text-xs font-mono font-semibold ${isShortage ? 'text-red-500' : isExcess ? 'text-blue-500' : variance === 0 ? 'text-green-600' : 'text-[#8B7355]'}`}>
                              {variance !== null ? (
                                <span className="block">
                                  <span className="flex items-center justify-end gap-1">
                                    {isShortage && <TrendingDown className="w-3 h-3" />}
                                    {isExcess && <TrendingUp className="w-3 h-3" />}
                                    {variance === 0 && <Minus className="w-3 h-3" />}
                                    {variance > 0 ? '+' : ''}{fmtQtyNum(variance)} {m.purchase_unit || m.unit}
                                  </span>
                                  {pf > 1 && (
                                    <span className="block text-[9px] font-normal text-[#B8A590]">
                                      = {variance > 0 ? '+' : ''}{fmtQtyNum(Math.round(variance * pf * 1e6) / 1e6)} {m.unit}
                                    </span>
                                  )}
                                </span>
                              ) : '-'}
                            </td>}
                            <td className="py-1.5 px-2">
                              <input
                                type="text"
                                value={ci?.notes || ''}
                                onChange={e => updateClosingItem(m.id, 'notes', e.target.value)}
                                placeholder="Optional"
                                className="w-full px-2 py-1 bg-white border border-[#D4B896] rounded text-xs text-[#2D1B0E] placeholder-[#C4B09A] focus:outline-none focus:ring-1 focus:ring-[#af4408]"
                              />
                            </td>
                          </tr>
                        );
                      })}

                      {/* ═══ SEMI-FINISHED SECTION (req 1) ═══════════════════
                          The 68 sub-recipes the kitchen actually holds at close.
                          Counted in their OWN yield unit — a sub-recipe has no
                          purchase unit and no pack factor, so nothing here is
                          converted. There is no system figure for them either,
                          so System / Variance read as an em-dash for admins
                          rather than a misleading zero. */}
                      {semiFiltered.length > 0 && (
                        <tr className="border-t-2 border-[#D4B896] bg-[#F5EDE2]">
                          <td colSpan={isAdmin ? 7 : 5} className="py-2 px-3">
                            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#6B5744] uppercase tracking-wide">
                              <Layers className="w-3.5 h-3.5" />
                              Semi-finished / sub-recipes
                              <span className="font-normal normal-case text-[10px] text-[#8B7355]">
                                — {semiFiltered.length} item{semiFiltered.length === 1 ? '' : 's'}, counted in each recipe&apos;s own yield unit (no pack conversion). Not department-mapped: count only what your section holds.
                              </span>
                            </span>
                          </td>
                        </tr>
                      )}
                      {semiFiltered.map((s) => {
                        const sv = closingSemi[s.id];
                        return (
                          <tr key={`semi-${s.id}`} className="border-t border-[#E8D5C4]/50 bg-[#FFFDF9]">
                            <td className="py-1.5 px-3 text-[#2D1B0E] font-medium text-xs">
                              {s.name}
                              <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-[#EDE3D5] text-[#6B5744] uppercase align-middle">semi</span>
                            </td>
                            <td className="py-1.5 px-3">
                              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-[#EDE3D5] text-[#6B5744]">
                                {categoryLabel(s.category || 'sub-recipe')}
                              </span>
                            </td>
                            {isAdmin && (
                              <td className="py-1.5 px-3 text-right text-xs font-mono">
                                <NoBasisDash what="system-stock" />
                              </td>
                            )}
                            <td className="py-1.5 px-3 text-right text-xs text-[#8B7355]" title="Sub-recipes are counted and costed in their yield unit — there is no purchase unit">
                              {s.yield_unit}
                            </td>
                            <td className="py-1.5 px-2">
                              <input
                                type="number" step="0.01" min="0"
                                value={sv?.physical_stock || ''}
                                onChange={e => updateClosingSemi(s.id, 'physical_stock', e.target.value)}
                                placeholder=""
                                className="w-full px-2 py-1 bg-white border border-[#D4B896] rounded text-xs text-right font-mono text-[#2D1B0E] focus:outline-none focus:ring-1 focus:ring-[#af4408] placeholder-[#C4B09A]"
                              />
                            </td>
                            {isAdmin && (
                              <td className="py-1.5 px-3 text-right text-xs font-mono">
                                <NoBasisDash what="variance" />
                              </td>
                            )}
                            <td className="py-1.5 px-2">
                              <input
                                type="text"
                                value={sv?.notes || ''}
                                onChange={e => updateClosingSemi(s.id, 'notes', e.target.value)}
                                placeholder="Optional"
                                className="w-full px-2 py-1 bg-white border border-[#D4B896] rounded text-xs text-[#2D1B0E] placeholder-[#C4B09A] focus:outline-none focus:ring-1 focus:ring-[#af4408]"
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Submit */}
                <div className="flex items-center justify-between">
                  <p className="text-xs text-[#8B7355]">
                    {deptScopedMaterials.filter((m: any) => (closingItems[m.id]?.physical_stock ?? '') !== '').length} of {deptScopedMaterials.length} items filled
                    {subRecipes.length > 0 && (
                      <> · {semiFilledCount} of {subRecipes.length} sub-recipes</>
                    )}
                  </p>
                  <div className="flex gap-3">
                    <button
                      onClick={() => setClosingStockOpen(false)}
                      className="px-4 py-2 text-sm text-[#6B5744] bg-[#FFF1E3] rounded-lg hover:bg-[#E8D5C4] transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={submitClosingStock}
                      disabled={closingSubmitting}
                      className="flex items-center gap-2 px-5 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                      {closingSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardCheck className="w-4 h-4" />}
                      {closingSubmitting ? 'Saving...' : 'Save Closing Stock'}
                    </button>
                  </div>
                </div>

                {/* Result */}
                {closingResult && (
                  <div className={`p-3 rounded-lg border ${closingResult.errors.length > 0 && closingResult.success === 0 && !closingResult.semi ? 'bg-red-50 border-red-200' : 'bg-green-50 border-green-200'}`}>
                    <div className="flex items-start gap-2 text-sm">
                      {(closingResult.success > 0 || (closingResult.semi ?? 0) > 0) ? <CheckCircle className="w-4 h-4 text-green-600 mt-0.5" /> : <AlertCircle className="w-4 h-4 text-red-500 mt-0.5" />}
                      <div>
                        {closingResult.success > 0 && <p className="text-green-700">Closing stock recorded for {closingResult.success} items!</p>}
                        {/* "Recorded" is not "posted". Split the same save by what
                            became of each variance so the two are never mistaken
                            for one another: amber = stock has moved and there is
                            nothing left to approve, muted = still sitting in the
                            queue. Zeroes stay hidden, so a save with no variance
                            at all reads exactly as it did before. */}
                        {/* isAdmin gates the WRAPPER, not just the spans inside it.
                            Gating only the children still emitted an empty <p> exactly
                            when a variance existed — invisible on screen, but a
                            DOM-level oracle for anyone who opens the inspector, which
                            is the same tell in a thinner disguise. */}
                        {isAdmin && ((closingResult.applied ?? 0) > 0 || (closingResult.pending ?? 0) > 0) && (
                          <p className="text-xs flex flex-wrap items-center gap-x-2">
                            {/* ADMIN-ONLY — see the blind-count note on the saveAll
                                flash above. Both clauses reveal whether the counted
                                figure matched system stock, which is the one thing a
                                blind count must not tell the counter. */}
                            {isAdmin && (closingResult.applied ?? 0) > 0 && (
                              <span className="text-amber-800 font-medium">· {closingResult.applied} applied to stock</span>
                            )}
                            {isAdmin && (closingResult.pending ?? 0) > 0 && (
                              <span className="text-[#8B7355]">· {closingResult.pending} sent for variance approval</span>
                            )}
                          </p>
                        )}
                        {(closingResult.semi ?? 0) > 0 && (
                          <p className="text-green-700">
                            {closingResult.semi} semi-finished item{closingResult.semi === 1 ? '' : 's'} recorded.
                          </p>
                        )}
                        {closingResult.errors.map((e, i) => <p key={i} className="text-red-600 text-xs">{e}</p>)}
                      </div>
                    </div>
                  </div>
                )}

                {/* ═══ VALUED SHEET (req 2 + 3) ═══════════════════════════════
                  * What the server RESOLVED AND STORED for the counts just
                  * saved: the rate that applied, Quantity × Rate per line, and
                  * the sheet total. Read back from /api/closing-stock, never
                  * recomputed here — the browser must not derive a rate, and
                  * raw_materials.last_purchase_price is unusable anyway (mixed
                  * bases on live data).
                  *
                  * The column name above is PROSE, not a read: this file never
                  * touches last_purchase_price. Every rate rendered below is
                  * `it.rate_per_purchase_unit`, stamped by the server through
                  * src/lib/closing-valuation.ts. Continuation lines carry the
                  * leading `*` so the rate-basis lock reads them as prose
                  * (scripts/check-rate-basis.js isProseLine) instead of as an
                  * LPP read — the sentence stays, the false hit goes. */}
                {valued && (valued.items.length > 0 || valued.semi.length > 0) && (
                  <div className="rounded-lg border border-[#E8D5C4] overflow-hidden">
                    <div className="px-3 py-2 bg-[#FFF1E3] flex items-center justify-between gap-3 flex-wrap">
                      <div className="text-xs font-semibold text-[#2D1B0E]">
                        Valued sheet — {valued.date}
                        <span className="ml-2 font-normal text-[10px] text-[#8B7355]">
                          rates resolved and stored by the server at count time
                        </span>
                      </div>
                      <div className="text-xs text-[#6B5744]">
                        Sheet total <span className="font-mono font-semibold text-[#2D1B0E]">{fmtMoney(valued.total)}</span>
                      </div>
                    </div>
                    {!valued.priced ? (
                      <p className="px-3 py-3 text-xs text-amber-800 bg-amber-50">
                        The counts saved, but this server build did not return per-item valuation, so no rate or value can be shown.
                      </p>
                    ) : (
                      <div className="overflow-x-auto max-h-[40vh] overflow-y-auto">
                        <table className="w-full text-xs">
                          <thead className="sticky top-0 bg-[#FFF8F0] text-[#8B7355]">
                            <tr>
                              <th className="text-left py-2 px-3 font-medium">Item</th>
                              <th className="text-right py-2 px-3 font-medium">Quantity</th>
                              <th className="text-right py-2 px-3 font-medium">Last purchase price</th>
                              <th className="text-right py-2 px-3 font-medium">Total value</th>
                            </tr>
                          </thead>
                          <tbody>
                            {valued.items.map((it: any) => {
                              // Rates are ₹ per PURCHASE unit, so the quantity
                              // beside them must be the PURCHASE quantity.
                              const vm = { unit: it.unit, purchase_unit: it.purchase_unit, pack_size: it.pack_size };
                              const vpu = it.purchase_unit || it.unit;
                              return (
                                <tr key={`v-${it.id}`} className="border-t border-[#E8D5C4]/50">
                                  <td className="py-1.5 px-3 text-[#2D1B0E]">{it.material_name}</td>
                                  <td className="py-1.5 px-3 text-right font-mono">
                                    {fmtQtyNum(toPurchaseQty(Number(it.physical_stock) || 0, vm))} {vpu}
                                    {packFactor(vm) > 1 && (
                                      <span className="block text-[9px] text-[#B8A590]">
                                        = {fmtQtyNum(Number(it.physical_stock) || 0)} {it.unit}
                                      </span>
                                    )}
                                  </td>
                                  <td className="py-1.5 px-3 text-right">
                                    <RateCell rate={it.rate_per_purchase_unit} source={it.rate_source} asOf={it.rate_as_of} purchaseUnit={vpu} stored={it.rate_is_stored} />
                                  </td>
                                  <td className="py-1.5 px-3 text-right">
                                    <ValueCell value={it.total_value} source={it.rate_source} rate={it.rate_per_purchase_unit} />
                                  </td>
                                </tr>
                              );
                            })}
                            {valued.semi.length > 0 && (
                              <tr className="border-t-2 border-[#D4B896] bg-[#F5EDE2]">
                                <td colSpan={4} className="py-1.5 px-3 text-[10px] font-semibold uppercase tracking-wide text-[#6B5744]">
                                  Semi-finished — costed per yield unit
                                </td>
                              </tr>
                            )}
                            {valued.semi.map((s: any) => (
                              <tr key={`vs-${s.id}`} className="border-t border-[#E8D5C4]/50 bg-[#FFFDF9]">
                                <td className="py-1.5 px-3 text-[#2D1B0E]">{s.name}</td>
                                {/* unit-lock: a sub-recipe is counted and costed in its OWN
                                    yield unit. It has no purchase unit and no pack factor, so
                                    there is nothing to convert and nothing to hint at. */}
                                <td className="py-1.5 px-3 text-right font-mono">
                                  {fmtQtyNum(Number(s.physical_stock) || 0)} {s.yield_unit || s.unit}
                                </td>
                                <td className="py-1.5 px-3 text-right">
                                  <RateCell rate={s.rate_per_unit} source={s.rate_source} purchaseUnit={s.yield_unit || s.unit} stored={s.rate_is_stored} />
                                </td>
                                <td className="py-1.5 px-3 text-right">
                                  <ValueCell value={s.total_value} source={s.rate_source} rate={s.rate_per_unit} />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot className="sticky bottom-0 bg-[#FFF1E3] font-semibold text-[#2D1B0E]">
                            <tr className="border-t-2 border-[#D4B896]">
                              <td className="py-2 px-3">
                                Sheet total
                                {unvaluedCount([...valued.items, ...valued.semi]) > 0 && (
                                  <span className="ml-2 font-normal text-[10px] text-[#8B7355]">
                                    {unvaluedCount([...valued.items, ...valued.semi])} item(s) had no price basis and are excluded
                                  </span>
                                )}
                              </td>
                              {/* Cross-material quantities never add up (ml + g + BTL) — em-dash. */}
                              <td className="py-2 px-3 text-right"><CrossDash what="quantity total" /></td>
                              <td className="py-2 px-3 text-right"><CrossDash what="rate total" /></td>
                              <td className="py-2 px-3 text-right font-mono">{fmtMoney(valued.total)}</td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
