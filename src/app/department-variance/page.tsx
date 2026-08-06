'use client';

/**
 * Department Variance — what a kitchen received, what its recipes say it used,
 * and how that compares to the last physical count of that kitchen.
 *
 * ── THE ONE RULE THIS PAGE EXISTS TO ENFORCE ───────────────────────────────
 * A number is printed ONLY when the system can explain it. Everything else is
 * an em-dash with a plain-English reason and a link to the page that fixes it.
 *
 * Measured on the live data the day this page was written: only 75 of 701
 * issued materials appear in ANY recipe attached to a live menu item, and only
 * 4 of 19 departments have a station that carries a recipe at all. Akan Main
 * Kitchen — the single largest receiver, 4,335 issued lines — has NO station
 * pointing at it. A naive "issued minus consumed" column would therefore flag
 * ~89% of the item list, and the busiest kitchen in the building, on day one,
 * entirely because of a DATA gap. The report would be an accusation the data
 * cannot support, and the first person to read it would (correctly) stop
 * trusting the whole module.
 *
 * So: `difference_state` is authoritative. Only 'ok' prints a number. Anything
 * else prints a dash, WHATEVER `difference` the API sent alongside it — see
 * cellDifference(). That belt-and-braces check is deliberate, not defensive
 * clutter: the SQL can compute a difference long before the data justifies
 * showing one, and a future contributor widening the query must not be able to
 * leak an unexplainable number onto this screen by accident.
 *
 * ── WORDS WE DO NOT USE ────────────────────────────────────────────────────
 * The column is "Difference vs count". The vocabulary an auditor reaches for
 * when goods have gone astray — and its softer synonyms — appears nowhere on
 * this page, in the CSV, or in these comments; a grep of this file for that
 * vocabulary must come back empty, and the reviewer checks. This is not a
 * euphemism exercise: a difference here has at least five innocent
 * explanations (no recipe attached, station not mapped, no count yet, a first
 * count with nothing before it, a count taken mid-service) and exactly one
 * culpable one. Naming the culpable one on a screen that cannot tell them
 * apart is how a reporting tool becomes a personnel problem. If you are adding
 * copy here, describe the ARITHMETIC ("count is lower than expected"), never
 * the cause.
 *
 * ── SIGN CONVENTION — READ THIS BEFORE TOUCHING cellDifference ─────────────
 * The API computes `difference = expected_at_count − counted`. So a POSITIVE
 * difference means the department counted LESS than the ledger expects, and a
 * negative one means it counted MORE. That is the opposite of the intuitive
 * "counted − expected", and flipping the wording is a silent, total inversion
 * of the report's meaning. The wording lives in ONE place (differenceWording)
 * so it can only be wrong once.
 *
 * ── WHAT THE FIGURES MEAN (all RECIPE units on the wire) ───────────────────
 *   opening       the cut-over opening balance for this department × material.
 *   issued_in     what Central issued into this department since the cut-over.
 *   consumption   what recipe consumption at KOT-complete / complimentary / NC
 *                 says this department used.
 *   other out     wastage + staff meals + issue reversals — real outflow that
 *                 is not recipe consumption, kept in its own column so it is
 *                 never mistaken for either of the two figures above. The
 *                 signed nets (adjustments / party / unrecognised) ride in the
 *                 tooltip rather than being folded in, because folding a
 *                 signed net into a column of positive magnitudes is how a
 *                 return starts reading as usage.
 *   ledger_balance the department's holding now, anchored on its latest count.
 *   last_count    the physical count the difference is measured at.
 *   difference    expected_at_count − last_count. Signed. Only when state='ok'.
 *
 * NOTE the API's own caveat: on a re-counted row (`recount_rebased`) the
 * movement columns and the balance deliberately do NOT add up, because the
 * balance re-anchors on the newer count while the movement columns still cover
 * the whole cut-over window. We flag those rows rather than hiding the seam.
 *
 * ── HISTORY IS EXCLUDED, AND SAYS SO ───────────────────────────────────────
 * Department balances start at the cut-over; the 14,149 historic issued lines
 * are NOT backfilled. `coverage.pre_cutover_excluded_lines` is rendered in its
 * own greyed, clearly-labelled block and is never summed into anything on this
 * page. Do not "tidy" it into the table — that is the whole no-backfill
 * decision, and the block is the only thing on screen that admits the gap.
 *
 * ── LIQUOR IS NOT HERE, ON PURPOSE ─────────────────────────────────────────
 * Store-mapped (TGBCL) materials live on the store rail and never enter a
 * department's raw-material holding, so the API excludes them entirely. The
 * footer says so. Do not "fix" their absence by widening the query — a
 * department variance against a holding that does not exist is noise.
 *
 * ── QUANTITY DISPLAY ───────────────────────────────────────────────────────
 * Owner rule, app-wide: every quantity LEADS in PURCHASE units with the recipe
 * figure as a small grey hint underneath. The wire stays RECIPE units; the
 * conversion happens here, through pack-units (the both-halves guard), so
 * PICKLED GINGER 1.5KG and friends do not get multiplied by their pack size.
 *
 * ── EVERY BADGE LINKS SOMEWHERE REAL ───────────────────────────────────────
 * A badge becomes a link only when canAccessPage() says this user can open its
 * target — the same authority the rest of the app uses. Targets are picked
 * from candidate lists (resolveHref) rather than hard-coded, and every
 * candidate was verified to exist as a route on disk. A badge that dead-ends
 * on a 404, or bounces a storekeeper off a page they cannot open, teaches
 * people the report is broken. Do not "simplify" resolveHref() into a string
 * literal.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle, Download, Info, Loader2, Lock, Scale, Search,
} from 'lucide-react';
import TabScroller from '@/components/TabScroller';
import { canAccessPage } from '@/lib/page-catalog';
import { fmtQtyNum, packFactor as sharedPackFactor, toPurchaseQty } from '@/lib/pack-units';

/* ───────────────────────────── wire types ─────────────────────────────────
 * GET /api/department-variance[?department_id=<id|csv>]
 * Mirrors src/app/api/department-variance/route.ts. Every quantity is in
 * RECIPE units. A null quantity means "not measurable", which is NOT the same
 * as 0 and must never be rendered as 0.
 * ────────────────────────────────────────────────────────────────────────── */

/** Why a row can or cannot be compared. 'ok' is the ONLY state that prints a
 *  number. 'no_opening' is the API's fourth non-comparable state (a first
 *  count has nothing earlier to be measured against); unknown strings are
 *  tolerated and shown verbatim, so a state added server-side degrades to a
 *  visible label rather than to a silent number. */
type DiffState = 'ok' | 'no_recipe' | 'station_unmapped' | 'not_counted' | 'no_opening' | (string & {});

interface Row {
  department_id: string;
  department_name: string;
  material_id: string;
  material_name: string;
  material_sku: string;
  category: string;
  unit: string;
  purchase_unit: string;
  pack_size: number;
  average_price: number;

  opening: number | null;
  opening_at: string | null;

  issued_in: number;
  consumption: number;
  wastage: number;
  staff_meal: number;
  reversals_out: number;
  adjustments_net: number;
  party_net: number;
  other_net: number;
  net_movement_since_cutover: number;

  ledger_balance: number | null;
  balance_value: number | null;
  anchor_source: string | null;
  never_counted: boolean;
  /** Balance re-anchored on a count newer than the cut-over, so the movement
   *  columns and the balance are on different windows. Flagged, not hidden. */
  recount_rebased: boolean;
  reconciles: boolean;

  last_count: number | null;
  last_count_date: string | null;

  expected_at_count: number | null;
  /** expected_at_count − last_count. Positive = counted LESS than expected. */
  difference: number | null;
  difference_value: number | null;
  difference_state: DiffState;
  difference_note: string;
  difference_available: boolean;

  recipe_reachable: boolean;
  mapped_stations: string[];
}

interface UnmappedStation {
  station: string;
  reason: string;
  note: string;
  /** liquor + kitchen are unmapped BY DESIGN. Never tell the owner to map
   *  these — see the seed's carve-out. */
  deliberate: boolean;
  menu_items: number;
  skipped_since_cutover: number;
}

interface Coverage {
  cutover_at: string | null;
  materials_issued: number;
  materials_issued_all: number;
  materials_with_recipe: number;
  departments_total: number;
  departments_consumption_reachable: number;
  unmapped_stations: string[];
  unmapped_station_detail: UnmappedStation[];
  station_map_available: boolean;
  consumption_skips_since_cutover: number;
  pre_cutover_excluded_lines: number;
  pre_cutover_included_in_any_column: boolean;
  liquor_materials_excluded: number;
  rows_total: number;
  rows_by_state: Record<string, number>;
}

interface Payload {
  cutover_at: string | null;
  coverage: Coverage;
  excludes: Record<string, string>;
  notes: Record<string, string>;
  rows: Row[];
}

interface Department { id: string; name: string; parent_id?: string | null; is_active?: number }
type Me = { role?: string; page_access?: string | null; is_head_chef?: boolean } | null;

/* ───────────────────────────── formatting ─────────────────────────────── */

const inr = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');
/** Recipe units per purchase unit — the ONE shared guard (pack-units). */
const packFactor = (r: Row) => sharedPackFactor(r);
/** Stored RECIPE qty → the purchase-unit figure printed on screen. */
const inPU = (r: Row, recipeQty: number) => fmtQtyNum(toPurchaseQty(recipeQty, r));
const puLabel = (r: Row) => r.purchase_unit || r.unit || '';
/** The small "= 30,000 g" second line. Null when the material never converts
 *  (a pack-1 item must not get a line repeating the same number twice — the
 *  both-halves guard lives in pack-units, do not reimplement it here) and null
 *  at zero, where "= 0 g" is pure noise on a page that already has a lot of
 *  rows to read. */
const recipeHint = (r: Row, recipeQty: number) =>
  packFactor(r) > 1 && Math.abs(recipeQty) > 1e-9
    ? `= ${fmtQtyNum(recipeQty)} ${r.unit}`
    : null;
const dateLabel = (s?: string | null) => {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T'));
  return isNaN(d.getTime())
    ? String(s).slice(0, 10)
    : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const EPS = 1e-9;
const Dash = () => <span className="text-[#B8A088]" aria-label="not comparable">—</span>;

/** Outflow that is NOT recipe consumption. Positive magnitudes only — the API
 *  reports these three as magnitudes; the signed nets stay out (see header). */
const otherOut = (r: Row) => (r.wastage || 0) + (r.staff_meal || 0) + (r.reversals_out || 0);
const signedNets = (r: Row) => (r.adjustments_net || 0) + (r.party_net || 0) + (r.other_net || 0);

/** THE SIGN, IN ONE PLACE. difference = expected − counted, so positive means
 *  the count came in BELOW what the ledger expects. Everything user-facing
 *  reads from here so the inversion can only ever be wrong once. */
function differenceWording(d: number): string {
  if (Math.abs(d) < EPS) return 'count matches the expected figure';
  return d > 0 ? 'count is lower than expected' : 'count is higher than expected';
}

/* ─────────────────────── badge targets (see header) ───────────────────────
 * Candidate paths in preference order. resolveHref() returns the first one
 * this user can open, else null, in which case the badge renders as plain
 * text. Every candidate below was verified to exist as a route on disk:
 *   src/app/recipes/page.tsx
 *   src/app/settings/station-departments/page.tsx
 *   src/app/inventory/closing-sheet/page.tsx
 *   src/app/closing-stock/page.tsx
 * If you add a candidate, verify the route exists first — an aspirational
 * href here is a 404 with a helpful-looking label on it.
 * ────────────────────────────────────────────────────────────────────────── */
const HREFS: Record<string, string[]> = {
  no_recipe:        ['/recipes'],
  station_unmapped: ['/settings/station-departments'],
  not_counted:      ['/inventory/closing-sheet', '/closing-stock'],
  no_opening:       ['/inventory/closing-sheet', '/closing-stock'],
};

const REASON_LABEL: Record<string, string> = {
  no_recipe:        'No recipe attached yet',
  station_unmapped: 'Station not mapped yet',
  not_counted:      'Not counted yet',
  no_opening:       'First count — nothing earlier to compare',
};

const REASON_HINT: Record<string, string> = {
  no_recipe:        'Attach a recipe to the dishes that use this item, then this row can be compared.',
  station_unmapped: 'Map the station to a department in Settings, then this row can be compared.',
  not_counted:      'Record a closing count for this department, then this row can be compared.',
  no_opening:       'This count sets the baseline. The next count for this item can be compared against it.',
};

/**
 * A badge links only where this user can actually go. canAccessPage() is the
 * app's access authority; we deliberately do NOT also require membership of
 * ALL_PAGE_PATHS, because that list is the NAV catalog — a route can be live
 * and reachable before someone adds it to the sidebar, and gating the link on
 * nav registration would silently strip working links off this page.
 */
function resolveHref(reason: string, me: Me): string | null {
  const candidates = HREFS[reason];
  if (!candidates || !me) return null;
  for (const path of candidates) if (canAccessPage(path, me)) return path;
  return null;
}

function ReasonBadge({ reason, me, title }: { reason: string; me: Me; title?: string }) {
  const label = REASON_LABEL[reason] || reason;
  const href = resolveHref(reason, me);
  const cls = 'inline-block px-1.5 py-0.5 rounded bg-[#FFF1E3] border border-[#E8D5C4] '
            + 'text-[#6B5744] text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap';
  const tip = title || REASON_HINT[reason] || '';
  // No reachable target → plain text. A badge that 404s, or that bounces this
  // user off a page they cannot open, teaches people the report is broken.
  if (!href) return <span className={cls} title={tip}>{label}</span>;
  return (
    <Link href={href} title={tip}
          className={cls + ' hover:border-[#af4408] hover:text-[#af4408] underline decoration-dotted underline-offset-2'}>
      {label}
    </Link>
  );
}

/* ────────────────────────────── the page ──────────────────────────────── */

export default function DepartmentVariancePage() {
  const [me, setMe] = useState<Me>(null);
  const [meLoaded, setMeLoaded] = useState(false);
  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(d => setMe(d?.user || null))
      .catch(() => {})
      .finally(() => setMeLoaded(true));
  }, []);

  /* The API gate is isManagement (admin | manager | head of department), and
   * the route's own comment records that isManagement ⊂ canSeeAllDeptStock —
   * so everyone who gets past the gate is entitled to EVERY department. That
   * is why there is no per-department scope filter here: adding one would
   * quietly show a manager a narrower list than the API is answering with,
   * and the two would disagree with nothing on screen to explain it. */
  const isManagement = !!me && (me.role === 'admin' || me.role === 'manager' || !!me.is_head_chef);

  const [departments, setDepartments] = useState<Department[]>([]);
  /** '' = every department (the API's own default when department_id is omitted). */
  const [selectedDept, setSelectedDept] = useState('');
  useEffect(() => {
    if (!isManagement) return;
    fetch('/api/departments').then(r => r.json())
      .then(d => setDepartments((d?.departments || []).filter((x: Department) => x.is_active)))
      .catch(() => {});
  }, [isManagement]);
  const byId = useMemo(() => new Map(departments.map(d => [d.id, d])), [departments]);
  const deptLabel = (d: Department) => {
    // A MAIN department expands server-side to its sub-departments, each still
    // reported on its OWN anchor. Say so, or the roll-up looks like a bug.
    if (!d.parent_id) return `${d.name} (main — incl. sub-departments)`;
    const parent = byId.get(d.parent_id);
    return parent ? `${d.name} · ${parent.name}` : d.name;
  };

  /* ── the report ────────────────────────────────────────────────────────── */
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** The cut-over gate is a SETUP state, not a failure. The API answers 400
   *  with cutover_at:null + a detail sentence until the opening balances are
   *  recorded; rendering that as a red error would read as "the report is
   *  broken" when the truthful message is "the report has not been started". */
  const [setupNeeded, setSetupNeeded] = useState<string | null>(null);

  useEffect(() => {
    if (!meLoaded) return;
    if (!isManagement) { setLoading(false); return; }
    setLoading(true); setError(null); setSetupNeeded(null);
    const qs = selectedDept ? `?department_id=${encodeURIComponent(selectedDept)}` : '';
    fetch(`/api/department-variance${qs}`)
      .then(async r => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          if (r.status === 400 && j?.cutover_at === null) {
            setData(null);
            setSetupNeeded(j.detail || j.error || 'Department opening balances have not been recorded yet.');
            return;
          }
          throw new Error(j?.error || `HTTP ${r.status}`);
        }
        setData(j as Payload);
      })
      .catch(e => { setData(null); setError(e.message); })
      .finally(() => setLoading(false));
  }, [meLoaded, isManagement, selectedDept]);

  const rows = data?.rows || [];
  const cov = data?.coverage;
  const allDepts = !selectedDept;

  /* ── filters (client-side, on purpose) ─────────────────────────────────────
   * The API accepts category= and state= filters, but coverage.rows_by_state
   * is computed AFTER those filters are applied — so filtering server-side
   * would make the census tiles describe the filtered view instead of the
   * whole department. The tiles are the honest part of this page; they read
   * the unfiltered census, and the table filters here.
   * ─────────────────────────────────────────────────────────────────────── */
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [onlyComparable, setOnlyComparable] = useState(false);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.category) set.add(r.category);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (category && r.category !== category) return false;
      if (onlyComparable && r.difference_state !== 'ok') return false;
      if (q && !(r.material_name || '').toLowerCase().includes(q)
            && !(r.material_sku || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, search, category, onlyComparable]);

  /** Stations the owner should actually act on. liquor and kitchen are unmapped
   *  BY DESIGN (liquor is the store rail; 'kitchen' is kot-fire's blank-station
   *  sentinel AND a real department name, so mapping it would debit the busiest
   *  kitchen for every station-less item in the building). Listing them under
   *  "map these" would be advice that must never be followed — hence the split.
   *  Do not collapse these two lists back together. */
  const actionableStations = (cov?.unmapped_station_detail || []).filter(s => !s.deliberate);
  const deliberateStations = (cov?.unmapped_station_detail || []).filter(s => s.deliberate);

  /* ── the difference cell ───────────────────────────────────────────────────
   * THE GUARD: difference_state wins over difference, always. If a future API
   * version starts sending a number alongside a non-'ok' state (an easy
   * mistake — the SQL can compute one long before the data justifies printing
   * it), this page still shows a dash. Printing an unexplainable number is the
   * one failure mode this whole report was designed to avoid.
   * ─────────────────────────────────────────────────────────────────────── */
  const cellDifference = (r: Row) => {
    const state = r.difference_state;
    if (state !== 'ok' || r.difference == null) {
      const stations = (r.mapped_stations || []).join(', ');
      return (
        <div className="flex flex-col items-end gap-1">
          <Dash />
          <div className="flex flex-wrap justify-end gap-1">
            <ReasonBadge
              reason={state}
              me={me}
              title={r.difference_note
                || (state === 'station_unmapped' && stations
                  ? `Stations ${stations} are not mapped to a department yet.`
                  : undefined)}
            />
          </div>
        </div>
      );
    }
    const d = r.difference;
    const flat = Math.abs(d) < EPS;
    // Arithmetic, not a verdict. Colour is a nudge, never a judgement: amber
    // for "lower than expected", sky for "higher", neutral for a match.
    const tone = flat ? 'text-[#6B5744]' : d > 0 ? 'text-amber-800' : 'text-sky-800';
    return (
      <div className="text-right" title={r.difference_note || undefined}>
        <div className={`font-bold ${tone}`}>
          {d > 0 ? '+' : ''}{inPU(r, d)} {puLabel(r)}
        </div>
        {recipeHint(r, d) && <div className="text-[9px] font-normal text-[#B8A590]">{recipeHint(r, d)}</div>}
        <div className="text-[9px] text-[#8B7355]">
          {differenceWording(d)}
          {r.difference_value != null && !flat ? ` · ${inr(Math.abs(r.difference_value))}` : ''}
        </div>
        {r.expected_at_count != null && (
          <div className="text-[9px] text-[#B8A590]">
            expected {inPU(r, r.expected_at_count)} {puLabel(r)}
          </div>
        )}
      </div>
    );
  };

  /* ── CSV — same columns, same neutral wording as the screen ───────────── */
  const exportCsv = () => {
    if (visible.length === 0) return;
    const headers = ['department', 'item', 'sku', 'category', 'purchase_unit',
                     'opening', 'issued_in', 'recipe_use', 'other_out', 'signed_net_adjustments',
                     'on_hand', 'counted', 'counted_on', 'expected_at_count',
                     'difference_vs_count', 'reading', 'status'];
    const label = (r: Row) => (r.difference_state === 'ok'
      ? 'Compared'
      : (REASON_LABEL[r.difference_state] || r.difference_state));
    const pu = (r: Row, v: number | null) => (v == null ? '' : toPurchaseQty(v, r));
    const lines = [headers.join(',')];
    for (const r of visible) {
      const comparable = r.difference_state === 'ok' && r.difference != null;
      lines.push([
        r.department_name, r.material_name, r.material_sku || '', r.category || '', puLabel(r),
        pu(r, r.opening), pu(r, r.issued_in), pu(r, r.consumption), pu(r, otherOut(r)),
        pu(r, signedNets(r)),
        pu(r, r.ledger_balance), pu(r, r.last_count), r.last_count_date || '',
        pu(r, r.expected_at_count),
        comparable ? pu(r, r.difference) : '',
        comparable ? differenceWording(r.difference as number) : '',
        label(r),
      ].map(v => {
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(','));
    }
    const scope = allDepts ? 'all-departments' : (rows[0]?.department_name || 'department');
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `department-variance-${scope.replace(/\s+/g, '-').toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /* ── access gate ───────────────────────────────────────────────────────── */
  if (meLoaded && !isManagement) {
    return (
      <div className="p-4 sm:p-6 max-w-3xl mx-auto">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 sm:p-8 text-center">
          <Lock className="w-8 h-8 mx-auto mb-3 text-[#B8A088]" />
          <h1 className="text-lg font-bold text-[#2D1B0E]">Department Variance</h1>
          <p className="text-sm text-[#6B5744] mt-2">
            This report is open to Admins, Managers and Heads of Department. Ask one of
            them to share the figures for your department.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex items-start gap-3">
        <Scale className="w-7 h-7 text-[#af4408] shrink-0" />
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-[#2D1B0E]">Department Variance</h1>
          <p className="text-xs text-[#6B5744]">
            What the store issued to a department, what its recipes say it used, and how that
            compares to the department&rsquo;s last physical count.
          </p>
        </div>
      </div>

      {/* ── THE PERMANENT PANEL ───────────────────────────────────────────────
          Not a toast and not dismissible, on purpose: it is the reading
          instruction for every dash on the page. Someone opening this report
          for the first time in six months needs it as much as someone opening
          it today, and a dismissed banner is exactly how a data gap gets
          mistaken for a finding. Do not add a close button.

          The two ratios are read LIVE from coverage — never hardcoded — so the
          panel keeps telling the truth as recipes and mappings get attached,
          and quietly congratulates the owner when the numbers close up. */}
      <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3 sm:p-4 flex items-start gap-3">
        <Info className="w-5 h-5 text-[#af4408] shrink-0 mt-0.5" />
        <div className="space-y-2 text-xs sm:text-[13px] text-[#4A3626] leading-relaxed min-w-0">
          <p>
            This report can only explain an item when it has a recipe <strong>and</strong> the
            kitchen that used it has a mapped station.
            {cov && (
              <> Right now <strong>{cov.materials_with_recipe} of {cov.materials_issued_all}</strong>{' '}
              issued items have a recipe, and{' '}
              <strong>{cov.departments_consumption_reachable} of {cov.departments_total}</strong>{' '}
              departments have a station mapped to a recipe.</>
            )}
            {' '}Everything else shows a dash — that means the system has not been told what the
            item should have been used for, not that anything is wrong.
          </p>
          {/* The cut-over line. Balances start there; history is excluded and
              SAID to be excluded (the no-backfill decision). When no cut-over
              is stamped yet, say that instead of naming a date we don't have. */}
          <p className="text-[#6B5744]">
            {data?.cutover_at
              ? <>Balances start from <strong>{dateLabel(data.cutover_at)}</strong>. Issues before
                 that date are shown separately and are not part of any figure on this page.</>
              : <>Balances start from the department opening cut-over, which has not been recorded
                 yet. Issues from before the cut-over are shown separately and are never part of
                 any figure on this page.</>}
          </p>
        </div>
      </div>

      {/* Department scope. Everyone who can read this page can read every
          department (see the isManagement note above), so the picker is a
          convenience, not a permission boundary. */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl px-4 py-3 flex items-center gap-3 flex-wrap">
        <span className="text-xs font-medium text-[#6B5744]">Department</span>
        <select value={selectedDept} onChange={e => setSelectedDept(e.target.value)}
                className="px-2 py-1.5 border border-[#D4B896] rounded text-sm bg-white max-w-full">
          <option value="">All departments</option>
          {departments.map(d => <option key={d.id} value={d.id}>{deptLabel(d)}</option>)}
        </select>
      </div>

      {/* Stations that fed a kitchen and resolve to nothing. Named, not
          counted-and-hidden: an unmapped station is a short setup task, and the
          alternative — guessing a department — would debit the wrong kitchen
          silently, which is the outcome this whole design refuses. */}
      {actionableStations.length > 0 && (
        <div className="flex items-start gap-2 bg-white border border-[#E8D5C4] rounded-xl px-4 py-2.5 text-xs text-[#6B5744]">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-[#D97706]" />
          <div className="min-w-0 space-y-1">
            <div>
              These stations sent items to a kitchen but are not mapped to a department yet:{' '}
              <strong>{actionableStations.map(s => s.station).join(', ')}</strong>. Their recipe use
              is recorded but is not attributed to any department, so those rows cannot be compared.
              {cov && cov.consumption_skips_since_cutover > 0
                && <> {cov.consumption_skips_since_cutover} consumption event
                     {cov.consumption_skips_since_cutover === 1 ? ' has' : 's have'} been recorded
                     without a department since the cut-over for this reason.</>}
            </div>
            <ReasonBadge reason="station_unmapped" me={me} />
          </div>
        </div>
      )}
      {deliberateStations.length > 0 && (
        <div className="text-[10px] text-[#8B7355] px-1">
          Left unmapped on purpose:{' '}
          <strong>{deliberateStations.map(s => s.station).join(', ')}</strong>. Liquor is tracked on
          the separate store ledger, and &ldquo;kitchen&rdquo; is the placeholder written when a dish
          carries no station of its own — mapping either one would attribute items to a kitchen that
          may not have used them.
        </div>
      )}
      {cov && cov.station_map_available === false && (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-xs text-amber-800">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            The station-to-department map is not available yet, so no recipe use can be attributed
            to a department. Every row will show a dash until it is set up.
          </span>
        </div>
      )}

      {/* Census — what the report can and cannot say, over the WHOLE selection
          (never the filtered table; see the filters note above). */}
      {cov && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="min-w-0 bg-white border border-[#E8D5C4] rounded-xl p-3 sm:p-4">
            <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Items</div>
            <div className="text-xl sm:text-2xl font-semibold text-[#2D1B0E] mt-1 tabular-nums">{cov.rows_total}</div>
            <div className="text-[9px] text-[#8B7355] mt-0.5">with movement or a count here</div>
          </div>
          <div className="min-w-0 bg-white border border-[#E8D5C4] rounded-xl p-3 sm:p-4">
            <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Can be compared</div>
            <div className="text-xl sm:text-2xl font-semibold text-[#2D1B0E] mt-1 tabular-nums">
              {cov.rows_by_state?.ok || 0}
            </div>
            <div className="text-[9px] text-[#8B7355] mt-0.5">
              {cov.rows_total > 0 ? Math.round(((cov.rows_by_state?.ok || 0) / cov.rows_total) * 100) : 0}% of the list
            </div>
          </div>
          <div className="min-w-0 bg-white border border-[#E8D5C4] rounded-xl p-3 sm:p-4">
            <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Waiting on a recipe</div>
            <div className="text-xl sm:text-2xl font-semibold text-[#6B5744] mt-1 tabular-nums">
              {cov.rows_by_state?.no_recipe || 0}
            </div>
            <div className="text-[9px] text-[#8B7355] mt-0.5"><ReasonBadge reason="no_recipe" me={me} /></div>
          </div>
          <div className="min-w-0 bg-white border border-[#E8D5C4] rounded-xl p-3 sm:p-4">
            <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Waiting on a count</div>
            <div className="text-xl sm:text-2xl font-semibold text-[#6B5744] mt-1 tabular-nums">
              {(cov.rows_by_state?.not_counted || 0) + (cov.rows_by_state?.no_opening || 0)}
            </div>
            <div className="text-[9px] text-[#8B7355] mt-0.5"><ReasonBadge reason="not_counted" me={me} /></div>
          </div>
        </div>
      )}

      {/* Pre-cut-over history — its own block, greyed, never summed in. This is
          the only thing on screen that admits the 14,149 historic issued lines
          exist, and the API asserts pre_cutover_included_in_any_column=false.
          Do not fold it into the table. */}
      {cov && cov.pre_cutover_excluded_lines > 0 && (
        <div className="bg-[#FAF6F1] border border-dashed border-[#D4B896] rounded-xl px-4 py-3 text-xs text-[#8B7355]">
          <span className="font-semibold text-[#6B5744]">
            Issued before {cov.cutover_at ? dateLabel(cov.cutover_at) : 'the cut-over'} (not in this balance):
          </span>{' '}
          {cov.pre_cutover_excluded_lines.toLocaleString('en-IN')} requisition line
          {cov.pre_cutover_excluded_lines === 1 ? '' : 's'}. Those issues were never posted to the
          department ledger, so they are noted here for reference only and are not part of any
          figure on this page.
        </div>
      )}

      {/* Filters */}
      {!setupNeeded && (
        <div className="space-y-2">
          <div className="flex gap-2 flex-wrap items-center">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8B7355]" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                     placeholder="Search items…"
                     className="w-full pl-8 pr-3 py-2 border border-[#E8D5C4] rounded-lg bg-white text-sm" />
            </div>
            <label className="flex items-center gap-1.5 text-xs text-[#6B5744] bg-white border border-[#E8D5C4] rounded-lg px-3 py-2 cursor-pointer">
              <input type="checkbox" checked={onlyComparable}
                     onChange={e => setOnlyComparable(e.target.checked)} />
              Only rows that can be compared
            </label>
            <button onClick={exportCsv} disabled={visible.length === 0}
                    className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-[#E8D5C4] bg-white text-[#6B5744] hover:border-[#af4408] disabled:opacity-40">
              <Download className="w-3.5 h-3.5" /> CSV
            </button>
          </div>
          {categories.length > 0 && (
            <TabScroller className="gap-1 text-xs">
              {['', ...categories].map(c => (
                <button key={c || '__all__'} onClick={() => setCategory(c)}
                        className={`px-2.5 py-1 rounded ${category === c
                          ? 'bg-[#af4408] text-white'
                          : 'bg-white border border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'}`}>
                  {c || 'All'}
                </button>
              ))}
            </TabScroller>
          )}
        </div>
      )}

      {/* The cut-over gate. A setup state, told plainly, with the route out. */}
      {setupNeeded && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-5 sm:p-6 text-sm text-[#4A3626] space-y-2">
          <div className="flex items-center gap-2 font-semibold text-[#2D1B0E]">
            <Info className="w-4 h-4 text-[#af4408]" /> Opening balances have not been recorded yet
          </div>
          <p className="text-xs leading-relaxed text-[#6B5744]">{setupNeeded}</p>
          <p className="text-xs leading-relaxed text-[#8B7355]">
            Until then this page has nothing to measure from. Nothing is wrong with the data —
            the department ledger simply starts on the day the opening count is recorded.
          </p>
        </div>
      )}

      {error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{error}</div>
      )}

      {loading ? (
        <div className="p-8 text-center text-[#8B7355]">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
        </div>
      ) : (!error && !setupNeeded && rows.length === 0) ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-sm text-[#8B7355]">
          <Scale className="w-8 h-8 mx-auto mb-2 opacity-50" />
          Nothing to compare here yet — rows appear once the store issues a requisition to a
          department, or a closing count is recorded for one.
        </div>
      ) : (!error && !setupNeeded) && (
        <>
          {/* Mobile / tablet-portrait: cards. The desktop table needs eight
              columns to stay honest (recipe use kept separate from other
              outflow), which cannot fit a narrow screen without hiding a leg of
              the arithmetic — and a hidden leg is how a dash starts looking
              like a finding. */}
          <div className="lg:hidden space-y-2">
            {visible.map(r => (
              <div key={`${r.department_id}::${r.material_id}`}
                   className="bg-white border border-[#E8D5C4] rounded-lg p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-bold text-[#2D1B0E] break-words">{r.material_name}</div>
                    <div className="text-[10px] text-[#8B7355]">
                      {allDepts ? `${r.department_name} · ` : ''}{r.category || '—'}
                    </div>
                  </div>
                  <div className="shrink-0 max-w-[55%]">{cellDifference(r)}</div>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-[#6B5744]">
                  <span>Opening: {r.opening == null ? <Dash /> : <>{inPU(r, r.opening)} {puLabel(r)}</>}</span>
                  <span>Issued in: {inPU(r, r.issued_in)} {puLabel(r)}</span>
                  <span>Recipe use: {inPU(r, r.consumption)} {puLabel(r)}</span>
                  <span>Other out: {inPU(r, otherOut(r))} {puLabel(r)}</span>
                  <span>On hand: {r.ledger_balance == null
                    ? <Dash /> : <>{inPU(r, r.ledger_balance)} {puLabel(r)}</>}</span>
                  <span>
                    Counted: {r.last_count == null
                      ? <Dash />
                      : <>{inPU(r, r.last_count)} {puLabel(r)}
                          {r.last_count_date ? ` · ${dateLabel(r.last_count_date)}` : ''}</>}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* Desktop */}
          <div className="hidden lg:block bg-white border border-[#E8D5C4] rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-[#8B7355] bg-[#FFF8F0]">
                <tr>
                  <th className="text-left  py-2 px-3 font-medium">Item</th>
                  <th className="text-right py-2 px-3 font-medium">Opening</th>
                  <th className="text-right py-2 px-3 font-medium">Issued in</th>
                  <th className="text-right py-2 px-3 font-medium">Recipe use</th>
                  <th className="text-right py-2 px-3 font-medium">Other out</th>
                  <th className="text-right py-2 px-3 font-medium">On hand</th>
                  <th className="text-right py-2 px-3 font-medium">Counted</th>
                  <th className="text-right py-2 px-3 font-medium whitespace-nowrap">Difference vs count</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(r => (
                  <tr key={`${r.department_id}::${r.material_id}`}
                      className="border-t border-[#E8D5C4]/50 align-top">
                    <td className="py-1.5 px-3">
                      <div className="font-medium text-[#2D1B0E]">{r.material_name}</div>
                      <div className="text-[10px] text-[#8B7355]">
                        {allDepts ? `${r.department_name} · ` : ''}{r.category || '—'}
                      </div>
                    </td>
                    <td className="py-1.5 px-3 text-right font-mono text-xs">
                      {r.opening == null ? <Dash /> : <>
                        {inPU(r, r.opening)} {puLabel(r)}
                        {recipeHint(r, r.opening) && <span className="block text-[9px] text-[#B8A590]">{recipeHint(r, r.opening)}</span>}
                      </>}
                    </td>
                    <td className="py-1.5 px-3 text-right font-mono text-xs">
                      {inPU(r, r.issued_in)} {puLabel(r)}
                      {recipeHint(r, r.issued_in) && <span className="block text-[9px] text-[#B8A590]">{recipeHint(r, r.issued_in)}</span>}
                    </td>
                    <td className="py-1.5 px-3 text-right font-mono text-xs">
                      {inPU(r, r.consumption)} {puLabel(r)}
                      {recipeHint(r, r.consumption) && <span className="block text-[9px] text-[#B8A590]">{recipeHint(r, r.consumption)}</span>}
                    </td>
                    {/* Wastage + staff meals + issue reversals. The signed nets
                        (adjustments / party / unrecognised types) are in the
                        tooltip, not added in — see the header note. */}
                    <td className="py-1.5 px-3 text-right font-mono text-xs text-[#8B7355]"
                        title={`Wastage ${fmtQtyNum(toPurchaseQty(r.wastage, r))} · `
                             + `Staff meals ${fmtQtyNum(toPurchaseQty(r.staff_meal, r))} · `
                             + `Issue reversals ${fmtQtyNum(toPurchaseQty(r.reversals_out, r))} · `
                             + `Adjustments/party (net) ${fmtQtyNum(toPurchaseQty(signedNets(r), r))} ${puLabel(r)}`}>
                      {inPU(r, otherOut(r))} {puLabel(r)}
                    </td>
                    {/* ONE REASON PER ROW. A never-counted row has no opening,
                        no balance and no count, so a badge in every one of
                        those cells prints the same sentence three times and
                        buries the row's actual figures. The reason lives in
                        the Difference column — the column the reader is asking
                        the question of — and these cells just show the dash. */}
                    <td className="py-1.5 px-3 text-right font-mono text-xs">
                      {r.ledger_balance == null ? (
                        <span title="Not counted yet, so there is no balance to show."><Dash /></span>
                      ) : <>
                        {inPU(r, r.ledger_balance)} {puLabel(r)}
                        {recipeHint(r, r.ledger_balance) && <span className="block text-[9px] text-[#B8A590]">{recipeHint(r, r.ledger_balance)}</span>}
                        {/* The balance re-anchored on a newer count while the
                            movement columns still cover the whole window, so
                            the row deliberately does not add up. Flag the seam
                            rather than quietly making the columns agree. */}
                        {r.recount_rebased && (
                          <span className="block text-[9px] text-[#8B7355]"
                                title="Re-anchored on a later count, so the movement columns above cover a longer window than this balance.">
                            re-based on a later count
                          </span>
                        )}
                      </>}
                    </td>
                    <td className="py-1.5 px-3 text-right font-mono text-xs">
                      {r.last_count == null ? (
                        <span title="No physical count recorded for this item in this department yet."><Dash /></span>
                      ) : <>
                        {inPU(r, r.last_count)} {puLabel(r)}
                        {r.last_count_date && <span className="block text-[9px] text-[#8B7355]">{dateLabel(r.last_count_date)}</span>}
                      </>}
                    </td>
                    <td className="py-1.5 px-3 font-mono text-xs">{cellDifference(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {visible.length === 0 && rows.length > 0 && (
            <div className="text-center text-xs text-[#8B7355] py-4">
              No items match{search ? ` “${search}”` : ''}{category ? ` in ${category}` : ''}
              {onlyComparable ? ' that can be compared yet' : ''}.
            </div>
          )}
        </>
      )}

      <p className="text-[10px] text-[#8B7355] leading-relaxed">
        Quantities lead in <strong>purchase units</strong> (kg / L / BTL); the small grey line
        underneath is the same figure in recipe units. A difference is only calculated when the
        department has a physical count for the item, the item is used by a recipe on a live menu
        item, and that dish&rsquo;s station is mapped to the department; every other row shows a
        dash and the reason. A positive difference means the count came in below the expected
        figure and a negative one above it — both are worth a look, and neither is a conclusion on
        its own.
        {cov && cov.liquor_materials_excluded > 0 && (
          <> Liquor is tracked on the separate store ledger and does not appear here
          ({cov.liquor_materials_excluded} item{cov.liquor_materials_excluded === 1 ? '' : 's'} excluded).</>
        )}
        {' '}Party stock is tracked on its own rail too.
      </p>
    </div>
  );
}
