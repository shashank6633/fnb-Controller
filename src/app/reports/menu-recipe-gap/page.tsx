'use client';

/**
 * MENU RECIPE GAP (/reports/menu-recipe-gap) — management only.
 *
 * BREAK 4 of the traceability audit, made visible and closeable.
 *
 * A dish with no recipe records zero food cost and moves no stock. That is not
 * a reporting gap — it is the reason the variance report and the food-cost
 * percentage cannot be believed for most of the menu.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS PAGE RENDERS THE SERVER'S ANSWER. IT DOES NOT INVENT ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 * Every number on screen comes from a field the route actually ships. Nothing
 * here is derived by adding buckets, and nothing is hardcoded from a past
 * measurement. This matters because the page and the route shipped with
 * MISMATCHED field names and the page read every missing field as zero: three
 * cards showed "—", all three sections showed 0 rows, and each printed its
 * "nothing to fix here" empty line. A silent, permanent, all-clear. If you
 * rename a field on either side, rename it on both, in the same commit.
 *
 * A load that cannot be understood is an ERROR, never an empty report. If the
 * payload has no `buckets` object the page refuses to render figures at all
 * (see `load`), because a recipe-gap report that reads "no gap" when it is
 * really broken is how a manager concludes the menu is fully costed.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SENTENCE THIS PAGE EXISTS TO SAY, AND WHY IT IS ABOVE THE FOLD
 * ═══════════════════════════════════════════════════════════════════════════
 * ATTACHING A RECIPE FIXES FUTURE SALES ONLY.
 *
 * db.ts recordSale() COPIES the recipe id onto the sale row at the moment the
 * item is punched, and order_items.recipe_id is the same kind of snapshot.
 * Deduction runs off that copy. So linking a recipe today does nothing at all
 * to a bill rung up yesterday — those rows keep their ₹0 cost forever, and no
 * button on this page changes that.
 *
 * That sentence renders in a banner directly under the H1, BEFORE the filters,
 * so it is on screen without scrolling on a desktop and is the first thing read
 * on a phone. The server ships the same sentence as `notice` and it is printed
 * verbatim beneath. If you move it, restyle it, or fold it into a tooltip,
 * someone will attach 200 recipes, watch last month's food cost stay at zero,
 * and report the deduction engine as broken. Leave it where it is.
 *
 * `unrepairable_sales` is the measured size of that limit — the sales rows that
 * carry no recipe id even though their menu item now has one. It is rendered as
 * its own panel, not a footnote, because it is what stops "we attached the
 * recipes" being heard as "the numbers are fixed now".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE BUCKETS, THREE DIFFERENT POPULATIONS, NEVER SUMMED
 * ═══════════════════════════════════════════════════════════════════════════
 * The sections below are the route's own three buckets, in the route's own
 * order, under the route's own labels, so the screen and the CSV cannot tell
 * different stories:
 *
 *   1  buckets.no_recipe        counts MENU ITEMS. The actionable list, ranked
 *                               by the revenue that has fallen through the hole.
 *                               Items with no sales in the window rank last with
 *                               ₹0 — that is an absence of evidence, not an
 *                               absence of risk.
 *   2  buckets.with_recipe      counts MENU ITEMS. Context only, not a to-do
 *                               list. Nothing here is tickable; these already
 *                               have a recipe and the server never overwrites.
 *   3  buckets.unmatched_sales  counts SALES NAMES. Not menu items. There is no
 *                               menu row to attach anything to, so nothing here
 *                               is tickable either.
 *
 * The server ships `buckets_are_never_summed` saying exactly this; it is printed
 * VERBATIM above section 1. There is no grand total on this page, in the CSV, or
 * in the payload — by design on all three. THIS PAGE ONCE HAD A "reconciliation"
 * LINE that added the buckets back to a period total. It has been removed: the
 * only field that could feed it does not exist, and computing it client-side
 * would have manufactured precisely the number the route refuses to print. Do
 * not reintroduce it, in any wording.
 *
 * Bucket totals are SQL aggregates over the FULL filtered set, computed
 * sales-side. They are never the sum of the rows on screen, so a truncated row
 * list can never understate a figure. Do not "fix" a count by counting rows.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE SALES→MENU LINK IS BY NAME, AND WHY BUCKET 3 EXISTS AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 * sales.pos_item_id is NULL on every row and menu_items.pos_id matches none of
 * them, so the only available join is a normalised name. The rows it does NOT
 * match are not dropped and are not folded into the ranked list — they get their
 * own labelled section, because a ranked table that silently omits half the
 * sales file would understate the gap to exactly the person trying to size it.
 * The server states this in `caveats.link_basis`, printed verbatim in section 3.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTHING IS APPLIED WITHOUT A TICK, AND THERE IS NO "TICK EVERYTHING"
 * ═══════════════════════════════════════════════════════════════════════════
 * The suggested recipe comes from src/lib/recipe-matcher.ts, which is fuzzy and
 * says so in its own header: it errs toward "no match" because a wrong link
 * pulls the WRONG food cost into every future sale of that dish. So:
 *
 *   · a row with no suggestion cannot be ticked — there is nothing to apply;
 *   · a row flagged `direct_material_linked` is badged DIRECT ITEM, because a
 *     food recipe is the wrong fix for a bottle of beer and the server says so
 *     in `caveats.direct_items`;
 *   · ticking is per row, and the POST sends only ticked pairs;
 *   · the ticked pairs are re-listed in a review panel and the attach button is
 *     only reachable from there;
 *   · there is deliberately NO "select all" control. One click that links 300
 *     dishes to fuzzy-matched recipes is the unattended bulk path the design
 *     explicitly refused. Do not add it back as a convenience.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WIRE CONTRACT — GET/POST /api/reports/menu-recipe-gap
 * ═══════════════════════════════════════════════════════════════════════════
 * Mirrored here as local types rather than imported, so this page compiles
 * independently of the route's build order. That mirroring is what allowed the
 * two sides to drift with tsc silent, so the types below are written to match
 * src/app/api/reports/menu-recipe-gap/route.ts FIELD FOR FIELD. Fields the route
 * ships but this page has no use for are still declared, so the next reader can
 * see what is available without opening the route.
 *
 *   GET  ?from=YYYY-MM-DD&to=YYYY-MM-DD&format=json|csv   → GapResponse | CSV
 *   POST { pairs: [{ menu_item_id, recipe_id }] }         → AttachResponse
 *
 * GET gates on isManagement (401/403); POST is stricter and gates on admin.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { todayIST } from '@/lib/format-date';
import {
  ChefHat, Download, AlertTriangle, Info, Loader2, TrendingDown, CircleSlash,
  CalendarDays, Check, X, Link2, ListChecks, RefreshCw, Search, Ban, History,
} from 'lucide-react';

/* ═══════════════════════════════ WIRE CONTRACT ═══════════════════════════ */

/**
 * One row, exactly as the route emits it. The suggestion is FLAT on the wire
 * (`suggested_recipe_id` / `suggested_recipe` / `suggestion_score` /
 * `suggestion_exact`) and is only populated on the no_recipe bucket — the score
 * fields are '' when there is no candidate, which is why they are typed
 * `number | ''` rather than nullable numbers.
 *
 * On unmatched_sales rows only `menu_item` (the sample sales name) and the
 * sales figures are populated; every menu-side field is ''/0 because there is
 * no menu row behind them.
 */
interface GapRow {
  bucket: 'no_recipe' | 'with_recipe' | 'unmatched_sales';
  menu_item_id: string;
  menu_item: string;
  category: string;
  item_type: string;
  /** 1/0, not a boolean. */
  is_active: number;
  selling_price: number;
  pos_id: string;
  recipe_id: string;
  recipe_name: string;
  /** 1 = menu_items.material_id is set. This still deducts NOTHING on sale. */
  direct_material_linked: number;
  direct_material: string;
  units_sold: number;
  revenue: number;
  /** From sales.total_cost. NOT a recipe food cost — see caveats. */
  recorded_food_cost: number;
  implausible_cost_rows: number;
  sale_rows: number;
  order_count: number;
  /** '' (not null) when it never sold in the window. */
  last_sold_date: string;
  suggested_recipe_id: string;
  suggested_recipe: string;
  suggestion_score: number | '';
  suggestion_exact: number | '';
}

/** A bucket's own totals. SQL aggregates over the full window, computed
 *  sales-side — never the sum of the rows on screen. */
interface BucketSales {
  distinct_sales_names: number;
  sale_rows: number;
  units_sold: number;
  revenue: number;
  recorded_food_cost: number;
  implausible_cost_rows: number;
}

/** Buckets 1 and 2: populations of MENU ITEMS. */
interface MenuBucket {
  label: string;
  /** Printed VERBATIM under the heading. Never paraphrase it on screen — it is
   *  the only thing stopping three sections being read as one number. */
  note: string;
  menu_item_count: number;
  /** no_recipe only. */
  menu_item_count_active?: number;
  /** no_recipe only — items a recipe is the WRONG fix for. */
  direct_material_linked_count?: number;
  sales: BucketSales;
  rows: GapRow[];
  truncated: boolean;
}

/** Bucket 3: a population of SALES NAMES. It has no menu_item_count because
 *  there are no menu items in it — that absence is the whole point. */
interface UnmatchedBucket {
  label: string;
  note: string;
  sales: BucketSales;
  rows: GapRow[];
  truncated: boolean;
}

interface UnrepairableSales {
  label: string;
  note: string;
  sale_rows: number;
  units_sold: number;
  revenue: number;
}

interface GapCaveats {
  link_basis: string;
  duplicate_menu_name_groups: number;
  duplicate_menu_name_effect: string;
  direct_items: string;
  order_count: string;
  suggestions: string;
  recorded_food_cost: string;
  sales_window: {
    sale_rows: number;
    rows_without_recipe_stamp: number;
    rows_with_recorded_cost: number;
    rows_recorded_cost_over_revenue: number;
    recorded_cost_total: number;
  };
}

interface GapResponse {
  from: string;
  to: string;
  window_is_default: boolean;
  limit: number;
  /** The future-only sentence, from the server. Printed verbatim. */
  notice: string;
  /** The no-grand-total sentence, from the server. Printed verbatim. */
  buckets_are_never_summed: string;
  buckets: {
    no_recipe: MenuBucket;
    with_recipe: MenuBucket;
    unmatched_sales: UnmatchedBucket;
  };
  unrepairable_sales: UnrepairableSales;
  caveats: GapCaveats;
}

/** One pair's fate, as the SERVER reports it. Never inferred from a 200.
 *  The verdict field is `status`, and the item's name is `menu_item`. */
interface AttachResult {
  menu_item_id: string;
  recipe_id: string;
  status: 'applied' | 'skipped';
  reason: string;
  /** Absent on the earliest skip paths (bad input, unknown id). */
  menu_item?: string;
  recipe_name?: string;
  existing_recipe_id?: string;
  recipe_is_active?: boolean;
}

interface AttachResponse {
  applied: number;
  skipped: number;
  results: AttachResult[];
  notice?: string;
  wrote?: string;
}

/* ══════════════════════════════════ format ═══════════════════════════════ */

const fmtINR = (n: number | null | undefined) =>
  '₹' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-IN');
const fmtNum = (n: number | null | undefined) => (Number(n) || 0).toLocaleString('en-IN');
/** Quantities sold are routinely fractional (0.5 portion) — do not round them away. */
const fmtQty = (n: number | null | undefined) =>
  (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

/** The flat suggestion fields, read as one thing. '' means "no candidate". */
const hasSuggestion = (r: GapRow) => String(r.suggested_recipe_id || '') !== '';
const sugScore = (r: GapRow) => Number(r.suggestion_score) || 0;
const sugExact = (r: GapRow) => Number(r.suggestion_exact) === 1;

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

/** Rows painted before asking. 610 unlinked items is a real list and painting
 *  every one of them with a checkbox locks a phone; the CSV always has all. */
const ROW_PAINT_CAP = 200;

const EMPTY_SALES: BucketSales = {
  distinct_sales_names: 0, sale_rows: 0, units_sold: 0, revenue: 0,
  recorded_food_cost: 0, implausible_cost_rows: 0,
};

/** Shells for a bucket the server omits, so a partial payload degrades to
 *  "nothing here" instead of crashing. A payload with NO buckets object at all
 *  is a different thing entirely and is treated as an error in `load`. */
function emptyMenuBucket(label: string): MenuBucket {
  return { label, note: '', menu_item_count: 0, sales: { ...EMPTY_SALES }, rows: [], truncated: false };
}
function emptyUnmatchedBucket(label: string): UnmatchedBucket {
  return { label, note: '', sales: { ...EMPTY_SALES }, rows: [], truncated: false };
}

/** A bucket that arrives without its `sales` block or its `rows` array would
 *  crash the render on the first `.revenue` / `.length`. Fill the holes once,
 *  here, rather than sprinkling `?.` over forty read sites where a missing
 *  figure would then quietly print as ₹0. Note what this does NOT do: it never
 *  invents a count from the rows — an absent aggregate stays 0 and the section
 *  reads as empty, which is visibly wrong rather than plausibly wrong. */
function normalizeMenuBucket(b: MenuBucket | undefined, label: string): MenuBucket {
  const base = emptyMenuBucket(label);
  if (!b || typeof b !== 'object') return base;
  return {
    ...base, ...b,
    label: b.label || label,
    sales: { ...EMPTY_SALES, ...(b.sales || {}) },
    rows: Array.isArray(b.rows) ? b.rows : [],
    truncated: !!b.truncated,
  };
}
function normalizeUnmatchedBucket(b: UnmatchedBucket | undefined, label: string): UnmatchedBucket {
  const base = emptyUnmatchedBucket(label);
  if (!b || typeof b !== 'object') return base;
  return {
    ...base, ...b,
    label: b.label || label,
    sales: { ...EMPTY_SALES, ...(b.sales || {}) },
    rows: Array.isArray(b.rows) ? b.rows : [],
    truncated: !!b.truncated,
  };
}

/* ════════════════════════════════ the page ═══════════════════════════════ */

export default function MenuRecipeGapPage() {
  const today = todayIST();
  // Default window: this financial year. Unlike the issue log, the question here
  // is "which dishes have earned money without recording a cost", and a 30-day
  // window makes a seasonal menu look clean.
  const [from, setFrom] = useState(fyStart(today));
  const [to, setTo] = useState(today);
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');

  const [data, setData] = useState<GapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [paintAll, setPaintAll] = useState<Record<string, boolean>>({});

  /** menu_item_id → recipe_id the user has ACCEPTED. A tick is an acceptance of
   *  that specific suggestion, so the recipe id is stored with it rather than
   *  re-read at submit time — the row could have been re-fetched in between. */
  const [ticked, setTicked] = useState<Record<string, string>>({});
  const [reviewing, setReviewing] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [attachResults, setAttachResults] = useState<AttachResponse | null>(null);
  const [attachError, setAttachError] = useState('');

  // Free-text search hits a multi-hundred-row payload filter locally, but the
  // debounce keeps re-render churn off the phone while typing.
  useEffect(() => { const id = setTimeout(() => setQLive(q.trim().toLowerCase()), 250); return () => clearTimeout(id); }, [q]);

  const qs = useCallback((format: 'json' | 'csv') => {
    const p = new URLSearchParams({ from, to, format });
    return p.toString();
  }, [from, to]);

  const load = useCallback(async () => {
    setLoading(true); setError(''); setPaintAll({});
    try {
      const res = await fetch(`/api/reports/menu-recipe-gap?${qs('json')}`, { cache: 'no-store' });
      // A failed load must never read as "no gap". An empty recipe-gap report
      // that is really a 403 is how a manager concludes the menu is fully costed.
      if (res.status === 401) { setError('Sign in required.'); setData(null); return; }
      if (res.status === 403) { setError('Management only — you don’t have access to the menu recipe gap.'); setData(null); return; }
      if (res.status === 404) { setError('The menu recipe gap API is not available on this build.'); setData(null); return; }
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as Record<string, unknown>));
        setError((j?.error as string) || `Failed to load the recipe gap (HTTP ${res.status}).`); setData(null); return;
      }
      const j = (await res.json().catch(() => null)) as Partial<GapResponse> | null;
      // A 200 whose body this page cannot read is NOT an empty report. Rendering
      // zeros here is the exact failure this page shipped with: every section
      // printed its "nothing to fix" line while the server was reporting 610
      // unlinked items. Refuse, loudly.
      if (!j || typeof j !== 'object' || !j.buckets || typeof j.buckets !== 'object') {
        setError('The recipe gap API answered in a shape this page does not recognise. Nothing is shown — an unreadable answer is not the same as "no gap". Report this rather than reading the report as clean.');
        setData(null); return;
      }
      setData({
        ...(j as GapResponse),
        buckets: {
          no_recipe: normalizeMenuBucket(j.buckets.no_recipe, 'Menu items with NO recipe'),
          with_recipe: normalizeMenuBucket(j.buckets.with_recipe, 'Menu items that HAVE a recipe (context only)'),
          unmatched_sales: normalizeUnmatchedBucket(j.buckets.unmatched_sales, 'Sold, not on the menu master'),
        },
      });
    } catch { setError('Network error — please try again.'); setData(null); }
    finally { setLoading(false); }
  }, [qs]);

  useEffect(() => { load(); }, [load]);

  const download = async () => {
    setDownloading(true); setError('');
    try {
      const res = await fetch(`/api/reports/menu-recipe-gap?${qs('csv')}`, { cache: 'no-store' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as Record<string, unknown>));
        setError((j?.error as string) || (res.status === 403 ? 'Management only — download refused.' : `Download failed (HTTP ${res.status}).`));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `menu-recipe-gap-${from}_${to}.csv`; a.click();
      URL.revokeObjectURL(url);
    } catch { setError('Network error — download failed.'); }
    finally { setDownloading(false); }
  };

  const noRecipe = data?.buckets?.no_recipe || emptyMenuBucket('Menu items with NO recipe');
  const withRecipe = data?.buckets?.with_recipe || emptyMenuBucket('Menu items that HAVE a recipe (context only)');
  const unmatched = data?.buckets?.unmatched_sales || emptyUnmatchedBucket('Sold, not on the menu master');
  const caveats = data?.caveats;
  const unrepairable = data?.unrepairable_sales;

  /**
   * RANKING. Revenue descending, always — the point of this report is "fix the
   * biggest holes first", and the server already returns it in that order. The
   * client re-sorts anyway so a text filter or a stale payload can never quietly
   * reorder the list into something that looks ranked but is not.
   */
  const noRecipeRows = useMemo(() => {
    const rows = [...(noRecipe.rows || [])];
    rows.sort((a, b) => (Number(b.revenue) || 0) - (Number(a.revenue) || 0)
      || (Number(b.units_sold) || 0) - (Number(a.units_sold) || 0)
      || String(a.menu_item).localeCompare(String(b.menu_item)));
    return qLive ? rows.filter(r => matchesQuery(r, qLive)) : rows;
  }, [noRecipe.rows, qLive]);

  const withRecipeRows = useMemo(() => {
    const rows = [...(withRecipe.rows || [])];
    rows.sort((a, b) => (Number(b.revenue) || 0) - (Number(a.revenue) || 0)
      || String(a.menu_item).localeCompare(String(b.menu_item)));
    return qLive ? rows.filter(r => matchesQuery(r, qLive)) : rows;
  }, [withRecipe.rows, qLive]);

  const unmatchedRows = useMemo(() => {
    const rows = [...(unmatched.rows || [])];
    rows.sort((a, b) => (Number(b.revenue) || 0) - (Number(a.revenue) || 0)
      || String(a.menu_item).localeCompare(String(b.menu_item)));
    return qLive ? rows.filter(r => String(r.menu_item || '').toLowerCase().includes(qLive)) : rows;
  }, [unmatched.rows, qLive]);

  /** The ticked pairs, resolved back to names for the review panel. Built from
   *  the no_recipe rows only — bucket 2 already has a recipe and the server
   *  never overwrites, and bucket 3 has no menu row at all. A tick whose row has
   *  vanished (window changed under the user) is dropped here, not posted blind. */
  const tickedPairs = useMemo(() => {
    const byId = new Map<string, GapRow>();
    for (const r of noRecipe.rows || []) byId.set(r.menu_item_id, r);
    const out: { item: GapRow; recipe_id: string; recipe_name: string; score: number; exact: boolean }[] = [];
    for (const [menuItemId, recipeId] of Object.entries(ticked)) {
      const item = byId.get(menuItemId);
      if (!item || !hasSuggestion(item)) continue;
      // The tick recorded a SPECIFIC recipe. If the reloaded suggestion is a
      // different recipe, the acceptance no longer describes what is on screen —
      // drop it rather than silently apply the new one.
      if (item.suggested_recipe_id !== recipeId) continue;
      out.push({ item, recipe_id: recipeId, recipe_name: item.suggested_recipe, score: sugScore(item), exact: sugExact(item) });
    }
    out.sort((a, b) => (Number(b.item.revenue) || 0) - (Number(a.item.revenue) || 0));
    return out;
  }, [ticked, noRecipe.rows]);

  /** Ticked rows whose menu item is a direct-material line. A food recipe is the
   *  wrong fix for a bottle — the server says so in caveats.direct_items and the
   *  review panel has to say it before the write, not after. */
  const tickedDirectCount = useMemo(
    () => tickedPairs.filter(p => Number(p.item.direct_material_linked) === 1).length,
    [tickedPairs],
  );

  const toggleTick = (item: GapRow) => {
    if (!hasSuggestion(item)) return;            // nothing to accept
    setAttachResults(null); setAttachError('');
    setTicked(prev => {
      const next = { ...prev };
      if (next[item.menu_item_id]) delete next[item.menu_item_id];
      else next[item.menu_item_id] = item.suggested_recipe_id;
      return next;
    });
  };

  const attach = async () => {
    if (tickedPairs.length === 0) return;
    setAttaching(true); setAttachError(''); setAttachResults(null);
    try {
      const res = await fetch('/api/reports/menu-recipe-gap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairs: tickedPairs.map(p => ({ menu_item_id: p.item.menu_item_id, recipe_id: p.recipe_id })) }),
      });
      if (res.status === 401) { setAttachError('Sign in required.'); return; }
      if (res.status === 403) { setAttachError('Refused — attaching a recipe is an admin action.'); return; }
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as Record<string, unknown>));
        setAttachError((j?.error as string) || `Attach failed (HTTP ${res.status}). Nothing was changed.`);
        return;
      }
      const j = (await res.json()) as AttachResponse;
      const results = Array.isArray(j.results) ? j.results : [];
      setAttachResults({
        results,
        // The server ships both counts; the fallbacks exist only so a truncated
        // body cannot print "0 attached" over a list that plainly says otherwise.
        applied: Number(j.applied ?? results.filter(r => r.status === 'applied').length),
        skipped: Number(j.skipped ?? results.filter(r => r.status !== 'applied').length),
        notice: j.notice,
        wrote: j.wrote,
      });
      // Only the pairs the SERVER says it applied stop being pending. A skipped
      // pair keeps its tick so the reason stays next to a row the user can act on.
      const applied = new Set(results.filter(r => r.status === 'applied').map(r => r.menu_item_id));
      setTicked(prev => {
        const next = { ...prev };
        for (const id of applied) delete next[id];
        return next;
      });
      setReviewing(false);
      await load();
    } catch { setAttachError('Network error — the attach may or may not have run. Reload before retrying.'); }
    finally { setAttaching(false); }
  };

  /* ── Headline, assembled from fields that exist. ─────────────────────────
     menu_items_total is NOT a wire field: the route partitions menu_items on
     recipe_id, so the two bucket counts are a partition of the whole menu and
     their sum IS the total. That is the one place two bucket numbers legally
     combine — they are two halves of one population, not two populations. It is
     not a revenue sum and it is not the forbidden grand total. */
  const menuItemsTotal = noRecipe.menu_item_count + withRecipe.menu_item_count;
  const sw = caveats?.sales_window;
  const salesRowsWithRecipeId = sw ? Math.max(0, sw.sale_rows - sw.rows_without_recipe_stamp) : 0;
  const hasFigures = !!data;

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E] overflow-x-hidden">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-5 sm:py-6 space-y-5">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">Reports</p>
            <h1 className="text-2xl sm:text-3xl font-bold mt-0.5 flex items-center gap-2">
              <ChefHat className="w-6 h-6 text-[#af4408] shrink-0" /> Menu Recipe Gap
            </h1>
            <p className="text-xs text-[#8B7355] mt-1">
              Menu items that remove nothing when they sell — ranked by the money they have actually taken.
            </p>
          </div>
          <Link href="/reports/issue-log" className="text-sm font-medium text-[#af4408] hover:underline shrink-0">Traceability Log →</Link>
        </div>

        {/*
          THE HONESTY LINE. Above the filters on purpose so it is on screen
          without scrolling on a desktop and is read first on a phone. See the
          file header before moving, shrinking or collapsing this. The server's
          own `notice` is printed verbatim underneath — it says the same thing in
          the API's words, and the API is what a spreadsheet reader sees.
        */}
        <div className="bg-[#FFF1E3] border-2 border-[#af4408] rounded-2xl px-4 py-3.5 sm:px-5 sm:py-4 shadow-sm">
          <p className="flex items-start gap-2 text-sm sm:text-base font-bold text-[#7a2f05] leading-snug">
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
            <span>Attaching a recipe fixes future sales only.</span>
          </p>
          <p className="text-xs sm:text-sm text-[#7a2f05] mt-1.5 leading-relaxed">
            The recipe id is <strong>copied onto the sale when the item is punched</strong>, and the cost deduction runs
            off that copy. So a bill already rung up keeps its zero food cost for ever — nothing on this page repairs
            history. Linking a recipe changes what happens the <em>next</em> time the dish is sold, and nothing else.
          </p>
          {data?.notice && (
            <p className="text-[11px] text-[#8a4a1c] mt-2 pt-2 border-t border-[#F0CDAE] leading-relaxed">
              <strong className="uppercase tracking-wide">From the API:</strong> {data.notice}
            </p>
          )}
        </div>

        {/* The measured headline, plainly. Every figure below is a field the
            route ships; nothing here is a stated historical measurement and
            nothing is a sum across buckets. */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatCard
              icon={<CircleSlash className="w-4 h-4" />}
              label="Menu items with no recipe"
              value={hasFigures ? `${fmtNum(noRecipe.menu_item_count)} of ${fmtNum(menuItemsTotal)}` : '—'}
              sub={hasFigures
                ? `${fmtNum(withRecipe.menu_item_count)} carry a recipe. ${fmtNum(noRecipe.menu_item_count_active ?? 0)} of the unlinked items are live on the menu. A dish with no recipe records zero food cost and moves no stock.`
                : 'Loading…'}
            />
            <StatCard
              icon={<Link2 className="w-4 h-4" />}
              label="Sales rows carrying a recipe id"
              value={sw ? `${fmtNum(salesRowsWithRecipeId)} of ${fmtNum(sw.sale_rows)}` : '—'}
              sub={sw
                ? 'The recipe id is snapshotted onto the sale row. A row without one recorded no cost and deducted nothing.'
                : 'Loading…'}
            />
            {/* Bucket 1's own revenue, alone. This card used to print
                "total minus matched", a figure the route refuses to ship
                precisely because it gets quoted as the size of the gap. The
                unmatched-sales money is named separately, not added. */}
            <StatCard
              icon={<TrendingDown className="w-4 h-4" />}
              label="Revenue on dishes with no recipe"
              value={hasFigures ? fmtINR(noRecipe.sales.revenue) : '—'}
              sub={hasFigures
                ? `Section 1, in this window. A separate ${fmtINR(unmatched.sales.revenue)} sold under names that match no menu item at all (section 3) — a different population, deliberately not added to this.`
                : 'Loading…'}
              alarm
            />
          </div>

          {data && (
            <p className="text-[11px] text-[#8B7355] leading-relaxed">
              Window <strong>{data.from}</strong> to <strong>{data.to}</strong> (IST)
              {data.window_is_default ? ' — server default: every sale on record.' : '.'}{' '}
              Menu-item counts are whole-database; the sales figures are for this window only.
            </p>
          )}

          {/* MEASURED recorded cost. The old copy here asserted "₹0 of food cost
              has been recorded" from a one-off reading. The server measures it,
              it is NOT zero, and it is NOT a food cost — printing the stale
              claim next to the live figure would make one of them a lie. */}
          {sw && (
            <p className="text-[11px] text-[#8B7355] leading-relaxed">
              <strong>In this window:</strong> {fmtNum(sw.sale_rows)} sale rows, {fmtNum(sw.rows_without_recipe_stamp)} with
              no recipe id stamped, {fmtNum(sw.rows_with_recorded_cost)} carrying a recorded cost of{' '}
              {fmtINR(sw.recorded_cost_total)} in total — of which{' '}
              <strong>{fmtNum(sw.rows_recorded_cost_over_revenue)} record a cost GREATER than their revenue</strong>.
              {caveats?.recorded_food_cost ? ` ${caveats.recorded_food_cost}` : ''}
            </p>
          )}
        </div>

        {/* ── What attaching cannot reach. Its own panel, not a footnote. ── */}
        {unrepairable && (
          <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm p-4">
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide flex items-center gap-1.5">
              <History className="w-4 h-4 text-[#af4408] shrink-0" />
              <span className="whitespace-normal">{unrepairable.label || 'Sales attaching cannot repair'}</span>
            </p>
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 mt-1.5">
              <span className="text-xl font-bold text-[#9A3412]">{fmtNum(unrepairable.sale_rows)}{' '}
                <span className="text-xs font-semibold text-[#8B7355]">sale rows</span></span>
              <span className="text-sm text-[#6B5744]">{fmtQty(unrepairable.units_sold)} units</span>
              <span className="text-sm text-[#6B5744]">Revenue <strong>{fmtINR(unrepairable.revenue)}</strong></span>
            </div>
            {unrepairable.note && (
              <p className="text-[11px] text-[#8B7355] mt-1.5 leading-relaxed whitespace-normal">{unrepairable.note}</p>
            )}
          </div>
        )}

        {/* Filters */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm p-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="block"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">From</span>
              <input type="date" value={from} onChange={e => e.target.value && setFrom(e.target.value)}
                className="mt-1 block px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]" /></label>
            <label className="block"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">To</span>
              <input type="date" value={to} onChange={e => e.target.value && setTo(e.target.value)}
                className="mt-1 block px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white text-sm outline-none focus:border-[#af4408]" /></label>

            <label className="block min-w-[200px] flex-1"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Find</span>
              <span className="mt-1 flex items-center gap-2 px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white focus-within:border-[#af4408]">
                <Search className="w-3.5 h-3.5 text-[#B8A48E] shrink-0" />
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="Dish, category or recipe…"
                  className="w-full text-sm outline-none bg-transparent" />
              </span></label>

            <button onClick={load} disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border bg-white text-[#af4408] border-[#E8D5C4] hover:bg-[#FFF1E3] disabled:opacity-60">
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh
            </button>
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
            {q && (
              <button onClick={() => setQ('')}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border bg-white text-[#af4408] border-[#E8D5C4] hover:bg-[#FFF1E3]">Clear search</button>
            )}
          </div>
        </div>

        {error && <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">{error}</div>}

        {/* The three-buckets warning. The server's own sentence is printed
            VERBATIM first; the plain-English gloss follows it. */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900 flex gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="space-y-1.5">
            <p><strong>{data?.buckets_are_never_summed
              || 'These buckets measure different populations (menu items vs sales names) and are deliberately never summed. There is no grand total in this report on purpose.'}</strong></p>
            <p>
              Sections 1 and 2 count <strong>menu items</strong>; together they are the whole menu, split by whether a
              recipe is attached. Section 3 counts <strong>sales names</strong> that match no menu item at all. Only
              section 1 can be fixed from this page — section 2 already has recipes and section 3 has no menu row to
              attach one to.
            </p>
          </div>
        </div>

        {/* ── SECTION 1: menu items with no recipe. The ranked, fixable list. ── */}
        <BucketShell
          n={1}
          title={noRecipe.label || 'Menu items with NO recipe'}
          note={noRecipe.note}
          fallbackNote="Counts menu items. Not comparable with the sales-name count in section 3."
          count={noRecipe.menu_item_count}
          countUnit="menu items"
          revenueLabel="Revenue in window"
          revenue={noRecipe.sales.revenue}
          units={noRecipe.sales.units_sold}
          saleRows={noRecipe.sales.sale_rows}
          extraLines={[
            `${fmtNum(noRecipe.menu_item_count_active ?? 0)} live on the menu`,
            `${fmtNum(noRecipe.direct_material_linked_count ?? 0)} direct-material lines a recipe is the wrong fix for`,
          ]}
          shown={noRecipeRows.length}
          loaded={(noRecipe.rows || []).length}
          truncated={noRecipe.truncated}
          loading={loading}
        >
          {caveats?.direct_items && (
            <div className="text-[11px] text-[#6B5744] bg-[#FDF6EF] border border-[#F0E4D6] rounded-lg px-3 py-2 mb-3 flex gap-2">
              <Ban className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[#B8A48E]" />
              <span>{caveats.direct_items} Rows in that state are badged <strong>DIRECT ITEM</strong> below.</span>
            </div>
          )}
          <GapTable
            rows={noRecipeRows}
            mode="attach"
            paintAll={!!paintAll.no_recipe}
            onPaintAll={() => setPaintAll(p => ({ ...p, no_recipe: true }))}
            ticked={ticked}
            onToggle={toggleTick}
            emptyText={loading ? 'Loading…' : error ? 'Not loaded — see the message above.' : 'Every menu item carries a recipe. That is the good answer.'}
          />
        </BucketShell>

        {/* ── SECTION 2: menu items that DO have a recipe. Context only. ── */}
        <BucketShell
          n={2}
          title={withRecipe.label || 'Menu items that HAVE a recipe (context only)'}
          note={withRecipe.note}
          fallbackNote="Counts menu items. Context only — not a to-do list, and not comparable with the sales-name count in section 3."
          count={withRecipe.menu_item_count}
          countUnit="menu items"
          revenueLabel="Revenue in window"
          revenue={withRecipe.sales.revenue}
          units={withRecipe.sales.units_sold}
          saleRows={withRecipe.sales.sale_rows}
          shown={withRecipeRows.length}
          loaded={(withRecipe.rows || []).length}
          truncated={withRecipe.truncated}
          loading={loading}
        >
          <div className="text-[11px] text-[#6B5744] bg-[#FDF6EF] border border-[#F0E4D6] rounded-lg px-3 py-2 mb-3 flex gap-2">
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[#B8A48E]" />
            <span>
              Nothing here is tickable. These items already carry a recipe and the server never overwrites an existing
              link. The section exists so the ranked list above can be read against the whole menu — a recipe attached
              here still only affects sales punched <em>after</em> it was attached.
            </span>
          </div>
          <GapTable
            rows={withRecipeRows}
            mode="context"
            paintAll={!!paintAll.with_recipe}
            onPaintAll={() => setPaintAll(p => ({ ...p, with_recipe: true }))}
            ticked={ticked}
            onToggle={toggleTick}
            emptyText={loading ? 'Loading…' : error ? 'Not loaded — see the message above.' : 'No menu item has a recipe attached.'}
          />
        </BucketShell>

        {/* ── SECTION 3: sold, not on the menu master. Nothing to attach. ── */}
        <BucketShell
          n={3}
          title={unmatched.label || 'Sold, not on the menu master'}
          note={unmatched.note}
          fallbackNote="Counts sales names, not menu items. Not comparable with the item counts in sections 1 and 2."
          count={unmatched.sales.distinct_sales_names}
          countUnit="sales names"
          revenueLabel="Revenue on these lines"
          revenue={unmatched.sales.revenue}
          units={unmatched.sales.units_sold}
          saleRows={unmatched.sales.sale_rows}
          shown={unmatchedRows.length}
          loaded={(unmatched.rows || []).length}
          truncated={unmatched.truncated}
          loading={loading}
        >
          <div className="text-[11px] text-[#6B5744] bg-[#FDF6EF] border border-[#F0E4D6] rounded-lg px-3 py-2 mb-3 flex gap-2">
            <Ban className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[#B8A48E]" />
            <span>
              {caveats?.link_basis
                || 'sales <-> menu_items joined on LOWER(TRIM(name)). sales.pos_item_id is NULL on every row and menu_items.pos_id matches none of them, so no id link exists.'}{' '}
              There is no menu row here to attach a recipe to and nothing in this section is tickable. Fix these by adding
              the dish to the menu master (or correcting its name); it then appears in section 1 or 2 above.
            </span>
          </div>
          <UnmatchedTable
            rows={unmatchedRows}
            paintAll={!!paintAll.unmatched}
            onPaintAll={() => setPaintAll(p => ({ ...p, unmatched: true }))}
            emptyText={loading ? 'Loading…' : error ? 'Not loaded — see the message above.' : 'Every sales row in this window matched a menu item by name.'}
          />
        </BucketShell>

        {/* How to read it, plus the server's own caveats printed verbatim. */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 text-[11px] text-[#6B5744] space-y-1.5 leading-relaxed">
          <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide">How to read this report</p>
          <p><strong>Attaching a recipe fixes future sales only.</strong> The recipe id is copied onto the sale line when
            the item is punched, so sales already rung up keep their zero cost. This is the single most important sentence
            on the page and it is repeated here on purpose.</p>
          <p><strong>The suggested recipe is a candidate, not an answer.</strong> It comes from a fuzzy name matcher that
            deliberately errs toward “no match”. A wrong link pulls the wrong food cost into every future sale of that
            dish. Read the suggestion before you tick it; an <em>exact</em> badge means the names are identical after
            normalising, anything else is a guess with a score attached.</p>
          <p><strong>Nothing is applied without a tick,</strong> and the tick list is shown again for review before the
            write. The server applies a pair only where the menu item currently has no recipe — it never overwrites an
            existing link — and it reports each pair’s outcome back, which is what the result panel prints.</p>
          <p><strong>Ranking is by revenue in the selected window,</strong> highest first, so the biggest holes sit at the
            top. Revenue here is what the sales rows recorded; no GST or cess figure appears anywhere on this page.</p>
          <p><strong>Section counts are server-side aggregates over the whole filtered set,</strong> not counts of the
            rows painted on screen, so a truncated table can never make a section look smaller than it is.</p>

          {caveats && (
            <div className="pt-2 mt-1 border-t border-[#F0E4D6] space-y-1.5">
              <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide">Caveats, from the server</p>
              {caveats.link_basis && <p><strong>Link basis.</strong> {caveats.link_basis}</p>}
              <p>
                <strong>Duplicate menu names.</strong> {fmtNum(caveats.duplicate_menu_name_groups)} normalised menu name
                {caveats.duplicate_menu_name_groups === 1 ? ' is' : 's are'} shared by more than one menu item.{' '}
                {caveats.duplicate_menu_name_effect}
              </p>
              {caveats.direct_items && <p><strong>Direct items.</strong> {caveats.direct_items}</p>}
              {caveats.order_count && <p><strong>Order counts.</strong> {caveats.order_count}</p>}
              {caveats.suggestions && <p><strong>Suggestions.</strong> {caveats.suggestions}</p>}
              {caveats.recorded_food_cost && <p><strong>Recorded cost.</strong> {caveats.recorded_food_cost}</p>}
              {data && (
                <p><strong>Row cap.</strong> The server returns at most {fmtNum(data.limit)} rows per section. Section
                  totals are unaffected by it; a section that hit the cap says so in red above its table, and the CSV
                  always contains every row.</p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── The attach dock. Fixed to the bottom so a tick made 300 rows down is
             never lost off screen. It only exists while something is ticked. ── */}
      {tickedPairs.length > 0 && (
        <div className="fixed bottom-0 inset-x-0 z-40 border-t border-[#E8D5C4] bg-white/95 backdrop-blur px-3 sm:px-6 py-3 shadow-[0_-2px_10px_rgba(0,0,0,0.06)]">
          <div className="max-w-7xl mx-auto flex flex-wrap items-center gap-3">
            <span className="text-sm font-semibold text-[#2D1B0E] inline-flex items-center gap-1.5">
              <ListChecks className="w-4 h-4 text-[#af4408]" />
              {fmtNum(tickedPairs.length)} recipe{tickedPairs.length === 1 ? '' : 's'} ticked
            </span>
            <span className="text-[11px] text-[#8B7355] hidden sm:inline">Future sales only — history is not repaired.</span>
            <span className="flex-1" />
            <button onClick={() => setTicked({})}
              className="px-3 py-2 rounded-lg text-xs font-medium border bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]">
              Clear ticks
            </button>
            <button onClick={() => setReviewing(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white">
              <ListChecks className="w-3.5 h-3.5" /> Attach selected recipes
            </button>
          </div>
        </div>
      )}
      {/* Keeps the last section clear of the fixed dock. */}
      {tickedPairs.length > 0 && <div className="h-20" aria-hidden />}

      {/* ── Review panel. The attach button is only reachable from here, so the
             last thing seen before the write is the exact list being written. ── */}
      {reviewing && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => !attaching && setReviewing(false)}>
          <div className="bg-white w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl shadow-xl max-h-[85vh] flex flex-col"
            onClick={e => e.stopPropagation()}>
            <div className="px-4 sm:px-5 py-3 border-b border-[#F0E4D6] flex items-center justify-between gap-3">
              <h3 className="font-bold text-[#2D1B0E] text-sm sm:text-base">Review before attaching</h3>
              <button onClick={() => !attaching && setReviewing(false)} className="text-[#8B7355] hover:text-[#2D1B0E]"><X className="w-4 h-4" /></button>
            </div>

            <div className="px-4 sm:px-5 py-3 bg-[#FFF1E3] border-b border-[#F0CDAE]">
              <p className="text-xs text-[#7a2f05] leading-relaxed">
                <strong>These {fmtNum(tickedPairs.length)} link{tickedPairs.length === 1 ? '' : 's'} affect future sales only.</strong>{' '}
                Sales already rung up keep their zero food cost. A pair is skipped by the server if the menu item already
                has a recipe — existing links are never overwritten.
              </p>
            </div>

            {tickedDirectCount > 0 && (
              <div className="px-4 sm:px-5 py-3 bg-amber-50 border-b border-amber-200">
                <p className="text-xs text-amber-900 leading-relaxed flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    <strong>{fmtNum(tickedDirectCount)} of these are direct-material lines</strong> (bottled/liquor items
                    carrying menu_items.material_id, badged DIRECT ITEM in the list). A food recipe is the wrong fix for
                    those, and attaching one makes every future sale deduct the wrong thing. Untick them unless you are
                    certain.
                  </span>
                </p>
              </div>
            )}

            <div className="overflow-y-auto px-4 sm:px-5 py-3 flex-1">
              <ul className="divide-y divide-[#F7EEE3]">
                {tickedPairs.map(p => (
                  <li key={p.item.menu_item_id} className="py-2 flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-[#2D1B0E] break-words">
                        {p.item.menu_item}
                        {Number(p.item.direct_material_linked) === 1 && <> <DirectBadge /></>}
                      </p>
                      <p className="text-[11px] text-[#8B7355] break-words">
                        → <span className="text-[#3F6B4C] font-medium">{p.recipe_name}</span>{' '}
                        <ScoreBadge score={p.score} exact={p.exact} />
                      </p>
                    </div>
                    <button onClick={() => toggleTick(p.item)} disabled={attaching}
                      className="text-[11px] text-[#af4408] hover:underline shrink-0 disabled:opacity-50">remove</button>
                  </li>
                ))}
              </ul>
            </div>

            {attachError && <div className="mx-4 sm:mx-5 mb-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800">{attachError}</div>}

            <div className="px-4 sm:px-5 py-3 border-t border-[#F0E4D6] flex items-center justify-end gap-2">
              <button onClick={() => setReviewing(false)} disabled={attaching}
                className="px-4 py-2 rounded-lg text-xs font-medium border bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3] disabled:opacity-60">Cancel</button>
              <button onClick={attach} disabled={attaching || tickedPairs.length === 0}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-60 text-white">
                {attaching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                Attach {fmtNum(tickedPairs.length)} recipe{tickedPairs.length === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Per-pair result. Printed from the SERVER's answer, never inferred
             from a 200 — a pair can be refused for a good reason and the user
             has to see which one and why. The verdict field is `status`. ── */}
      {attachResults && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setAttachResults(null)}>
          <div className="bg-white w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl shadow-xl max-h-[85vh] flex flex-col"
            onClick={e => e.stopPropagation()}>
            <div className="px-4 sm:px-5 py-3 border-b border-[#F0E4D6] flex items-center justify-between gap-3">
              <h3 className="font-bold text-[#2D1B0E] text-sm sm:text-base">
                {fmtNum(attachResults.applied)} attached · {fmtNum(attachResults.skipped)} skipped
              </h3>
              <button onClick={() => setAttachResults(null)} className="text-[#8B7355] hover:text-[#2D1B0E]"><X className="w-4 h-4" /></button>
            </div>
            <div className="px-4 sm:px-5 py-3 bg-[#FFF1E3] border-b border-[#F0CDAE]">
              <p className="text-xs text-[#7a2f05] leading-relaxed">
                <strong>This changes future sales only.</strong> Bills already rung up keep their zero food cost — the
                recipe id was copied onto those sale rows when the items were punched.
              </p>
              {attachResults.notice && (
                <p className="text-[11px] text-[#8a4a1c] mt-1.5 leading-relaxed">{attachResults.notice}</p>
              )}
            </div>
            <div className="overflow-y-auto px-4 sm:px-5 py-3 flex-1">
              <ul className="divide-y divide-[#F7EEE3]">
                {attachResults.results.map((r, i) => (
                  <li key={`${r.menu_item_id}-${i}`} className="py-2 flex items-start gap-2">
                    {r.status === 'applied'
                      ? <Check className="w-4 h-4 text-[#3F6B4C] shrink-0 mt-0.5" />
                      : <CircleSlash className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />}
                    <div className="min-w-0">
                      <p className="text-sm text-[#2D1B0E] break-words">{r.menu_item || r.menu_item_id}</p>
                      <p className="text-[11px] text-[#8B7355] break-words">
                        {r.status === 'applied'
                          ? <>linked to <span className="text-[#3F6B4C] font-medium">{r.recipe_name || r.recipe_id}</span></>
                          : <span className="text-amber-800">skipped — {r.reason || 'no reason given by the server'}</span>}
                      </p>
                      {/* The server flags an attach to an INACTIVE recipe as a
                          warning inside `reason`. Repeat it in its own line so
                          it is not lost at the end of a sentence. */}
                      {r.status === 'applied' && r.recipe_is_active === false && (
                        <p className="text-[11px] text-amber-800 break-words">
                          Warning: that recipe is marked inactive. {r.reason}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
                {attachResults.results.length === 0 && (
                  <li className="py-3 text-sm text-[#8B7355]">The server returned no per-pair result. Nothing can be confirmed from here — reload and check the items.</li>
                )}
              </ul>
            </div>
            {attachResults.wrote && (
              <p className="px-4 sm:px-5 pb-1 text-[11px] text-[#8B7355] leading-relaxed">{attachResults.wrote}</p>
            )}
            <div className="px-4 sm:px-5 py-3 border-t border-[#F0E4D6] flex justify-end">
              <button onClick={() => setAttachResults(null)}
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white">Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════ sub-components ══════════════════════════ */

/** menu_items.item_code is NOT on the wire and pos_id is empty on every row, so
 *  neither is searchable here. Searching a field the payload never carries reads
 *  as "no results" and looks like a data problem. */
function matchesQuery(r: GapRow, needle: string) {
  return `${r.menu_item} ${r.category} ${r.item_type} ${r.recipe_name} ${r.suggested_recipe} ${r.direct_material}`
    .toLowerCase().includes(needle);
}

function StatCard({ icon, label, value, sub, alarm }: {
  icon: React.ReactNode; label: string; value: string; sub: string; alarm?: boolean;
}) {
  return (
    <div className={`rounded-xl border p-3.5 ${alarm ? 'border-[#F5D0C2] bg-[#FDEEEA]' : 'border-[#E8D5C4] bg-white'}`}>
      <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wide flex items-center gap-1.5">
        <span className="text-[#af4408] shrink-0">{icon}</span><span className="truncate">{label}</span>
      </p>
      <p className={`text-xl font-bold mt-1 ${alarm ? 'text-[#9A3412]' : 'text-[#2D1B0E]'}`}>{value}</p>
      <p className="text-[10px] text-[#8B7355] mt-1.5 whitespace-normal leading-snug">{sub}</p>
    </div>
  );
}

/**
 * One bucket, with its own count, its own money, and the server's own `note`
 * printed verbatim. The number is captioned with WHAT it counts ("menu items" /
 * "sales names") because that caption is the whole reason the three sections
 * cannot be added.
 *
 * `count` is always the SERVER's aggregate. `loaded` is how many rows arrived
 * and `shown` how many survive the search box — those two are only ever used to
 * caption the table, never to state the size of the bucket.
 */
function BucketShell({
  n, title, note, fallbackNote, count, countUnit, revenue, revenueLabel, units, saleRows,
  extraLines, shown, loaded, truncated, loading, children,
}: {
  n: number; title: string; note: string; fallbackNote: string;
  count: number; countUnit: string;
  revenue: number; revenueLabel: string; units: number; saleRows: number;
  extraLines?: string[];
  shown: number; loaded: number; truncated: boolean; loading: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl shadow-sm p-4 sm:p-5">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 mb-1">
        <h2 className="text-sm font-bold flex items-start gap-2 min-w-0">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-[#FFF1E3] text-[#af4408] text-[11px] font-bold shrink-0 mt-0.5">{n}</span>
          <span className="whitespace-normal">{title}</span>
        </h2>
        {loading && <span className="text-xs text-[#8B7355] inline-flex items-center gap-1.5 shrink-0"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</span>}
      </div>

      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-1.5">
        <span className="text-lg font-bold text-[#2D1B0E]">
          {fmtNum(count)} <span className="text-xs font-semibold text-[#8B7355]">{countUnit}</span>
        </span>
        <span className="text-sm text-[#6B5744]">{revenueLabel} <strong>{fmtINR(revenue)}</strong></span>
        {units > 0 && <span className="text-xs text-[#8B7355]">{fmtQty(units)} units sold</span>}
        {saleRows > 0 && <span className="text-xs text-[#8B7355]">{fmtNum(saleRows)} sale rows</span>}
        {/* Only ever a caption on the TABLE. `count` above is the server's
            aggregate and is not recomputed from the rows. */}
        {shown !== loaded && (
          <span className="text-[11px] text-[#B8A48E]">showing {fmtNum(shown)} of {fmtNum(loaded)} loaded rows after search</span>
        )}
      </div>

      {!!extraLines?.length && (
        <p className="text-[11px] text-[#8B7355] mb-1.5">{extraLines.join(' · ')}</p>
      )}

      <p className="text-[11px] text-[#8B7355] mb-3 whitespace-normal leading-snug">{note || fallbackNote}</p>

      {truncated && (
        <div className="bg-[#af4408] text-white rounded-lg px-3 py-2 text-xs font-semibold flex items-start gap-2 mb-3">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>The server TRUNCATED this row list — it is not every row. The count and money above are still complete
            (they are SQL aggregates over the whole set). Narrow the window or download the CSV for every row.</span>
        </div>
      )}

      {children}
    </div>
  );
}

function ScoreBadge({ score, exact }: { score: number; exact: boolean }) {
  const pct = Math.round(Math.max(0, Math.min(1, Number(score) || 0)) * 100);
  // `exact` is a normalised-name identity — the only match that is not a guess.
  // Everything else is banded so a 62% candidate cannot pass for a certainty.
  const tone = exact ? 'bg-[#EDF4EE] text-[#3F6B4C] border-[#CFE2D4]'
    : pct >= 80 ? 'bg-[#FFF1E3] text-[#af4408] border-[#F0CDAE]'
    : 'bg-amber-50 text-amber-800 border-amber-200';
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-bold tracking-wide ${tone}`}>
      {exact ? 'EXACT NAME' : `${pct}% GUESS`}
    </span>
  );
}

/** menu_items.material_id is set on this row. It deducts NOTHING on sale, and a
 *  food recipe is the wrong fix for it — see caveats.direct_items. */
function DirectBadge() {
  return (
    <span className="inline-block px-1.5 py-0.5 rounded border text-[10px] font-bold tracking-wide bg-amber-50 text-amber-800 border-amber-200">
      DIRECT ITEM
    </span>
  );
}

/**
 * Sections 1 and 2 share a table. `mode` is the difference:
 *   attach  — no recipe yet: checkbox + the fuzzy suggestion column;
 *   context — already linked: no checkbox, and the attached recipe is shown
 *             instead of a suggestion (the server ships none for this bucket).
 */
function GapTable({ rows, mode, paintAll, onPaintAll, ticked, onToggle, emptyText }: {
  rows: GapRow[]; mode: 'attach' | 'context'; paintAll: boolean; onPaintAll: () => void;
  ticked: Record<string, string>; onToggle: (r: GapRow) => void; emptyText: string;
}) {
  const limit = paintAll ? rows.length : ROW_PAINT_CAP;
  const attachMode = mode === 'attach';
  const cols = attachMode ? 7 : 6;
  return (
    <>
      {/* The table scrolls inside THIS container. The page body must never
          scroll horizontally on a phone — hence overflow-x-hidden on the page
          shell and overflow-x-auto only here. */}
      <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
        <table className="w-full text-sm whitespace-nowrap">
          <thead><tr className="text-left text-[11px] uppercase text-[#8B7355] border-b border-[#F0E4D6]">
            {attachMode && <th className="py-2 pr-2 w-8"><span className="sr-only">Accept suggestion</span></th>}
            <th className="py-2 px-3">Menu item</th>
            <th className="py-2 px-3">Category</th>
            <th className="py-2 px-3 text-right">Units</th>
            <th className="py-2 px-3 text-right">Revenue</th>
            <th className="py-2 px-3">Last sold</th>
            <th className="py-2 pl-3">{attachMode ? 'Suggested recipe' : 'Attached recipe'}</th>
          </tr></thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={cols} className="py-6 text-center text-[#8B7355]">{emptyText}</td></tr>
            ) : rows.slice(0, limit).map(r => {
              const isTicked = !!ticked[r.menu_item_id];
              const suggested = hasSuggestion(r);
              return (
                <tr key={r.menu_item_id} className={`border-b border-[#F7EEE3] last:border-0 align-top ${isTicked ? 'bg-[#FFF6EE]' : ''}`}>
                  {attachMode && (
                    <td className="py-2 pr-2">
                      {/* No suggestion ⇒ no tick. There is nothing to accept, and a
                          checkbox that does nothing invites a bulk selection that
                          silently applies fewer pairs than it appears to. */}
                      <input
                        type="checkbox"
                        className="accent-[#af4408] w-4 h-4 disabled:opacity-30"
                        checked={isTicked}
                        disabled={!suggested}
                        onChange={() => onToggle(r)}
                        aria-label={suggested ? `Attach ${r.suggested_recipe} to ${r.menu_item}` : `${r.menu_item} has no suggested recipe`}
                      />
                    </td>
                  )}
                  <td className="py-2 px-3 font-medium whitespace-normal min-w-[180px]">
                    {r.menu_item || '—'}
                    {Number(r.direct_material_linked) === 1 && <> <DirectBadge /></>}
                    <span className="block text-[10px] text-[#8B7355] font-normal">
                      {fmtINR(r.selling_price)}
                      {Number(r.is_active) !== 1 ? ' · inactive' : ''}
                      {r.direct_material ? ` · direct material: ${r.direct_material}` : ''}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-[#6B5744] whitespace-normal min-w-[110px]">{r.category || '—'}</td>
                  <td className="py-2 px-3 text-right tabular-nums">{fmtQty(r.units_sold)}</td>
                  <td className="py-2 px-3 text-right tabular-nums font-semibold">{fmtINR(r.revenue)}</td>
                  <td className="py-2 px-3 text-[#6B5744]">{r.last_sold_date || 'not sold in window'}</td>
                  <td className="py-2 pl-3 whitespace-normal min-w-[210px]">
                    {!attachMode ? (
                      <span className="text-[#2D1B0E]">{r.recipe_name || r.recipe_id || '—'}</span>
                    ) : suggested ? (
                      <>
                        <span className="text-[#2D1B0E]">{r.suggested_recipe}</span>{' '}
                        <ScoreBadge score={sugScore(r)} exact={sugExact(r)} />
                        <span className="block text-[10px] text-[#B8A48E]">a candidate — read it before ticking</span>
                      </>
                    ) : (
                      <span className="text-[#B8A48E] inline-flex items-center gap-1">
                        <CircleSlash className="w-3 h-3 shrink-0" /> no confident match — needs a recipe written
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {rows.length > limit && (
        <div className="pt-3 flex flex-wrap items-center gap-2 text-xs text-[#8B7355]">
          <Info className="w-3.5 h-3.5 shrink-0" />
          Showing the first {fmtNum(limit)} of {fmtNum(rows.length)} on screen — the CSV contains all of them.
          <button onClick={onPaintAll} className="px-2.5 py-1 rounded-md border border-[#E8D5C4] text-[#af4408] hover:bg-[#FFF1E3] font-semibold">
            Show all {fmtNum(rows.length)}
          </button>
        </div>
      )}
    </>
  );
}

/**
 * Section 3. These rows are sales names, not menu items: every menu-side field
 * on the wire is blank for them, which is why there is no Category column here —
 * the route's unmatched rows carry no category and a column of dashes reads as
 * missing data rather than as "there is no menu row behind this".
 */
function UnmatchedTable({ rows, paintAll, onPaintAll, emptyText }: {
  rows: GapRow[]; paintAll: boolean; onPaintAll: () => void; emptyText: string;
}) {
  const limit = paintAll ? rows.length : ROW_PAINT_CAP;
  return (
    <>
      <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
        <table className="w-full text-sm whitespace-nowrap">
          <thead><tr className="text-left text-[11px] uppercase text-[#8B7355] border-b border-[#F0E4D6]">
            <th className="py-2 pr-3">Sold as</th>
            <th className="py-2 px-3 text-right">Sale rows</th>
            <th className="py-2 px-3 text-right">Units</th>
            <th className="py-2 px-3 text-right">Revenue</th>
            <th className="py-2 pl-3">Last sold</th>
          </tr></thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={5} className="py-6 text-center text-[#8B7355]">{emptyText}</td></tr>
            ) : rows.slice(0, limit).map((r, i) => (
              <tr key={`${r.menu_item}-${i}`} className="border-b border-[#F7EEE3] last:border-0 align-top">
                <td className="py-2 pr-3 font-medium whitespace-normal min-w-[180px]">{r.menu_item || '—'}</td>
                <td className="py-2 px-3 text-right tabular-nums">{fmtNum(r.sale_rows)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{fmtQty(r.units_sold)}</td>
                <td className="py-2 px-3 text-right tabular-nums font-semibold">{fmtINR(r.revenue)}</td>
                <td className="py-2 pl-3 text-[#6B5744]">{r.last_sold_date || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length > limit && (
        <div className="pt-3 flex flex-wrap items-center gap-2 text-xs text-[#8B7355]">
          <Info className="w-3.5 h-3.5 shrink-0" />
          Showing the first {fmtNum(limit)} of {fmtNum(rows.length)} on screen — the CSV contains all of them.
          <button onClick={onPaintAll} className="px-2.5 py-1 rounded-md border border-[#E8D5C4] text-[#af4408] hover:bg-[#FFF1E3] font-semibold">
            Show all {fmtNum(rows.length)}
          </button>
        </div>
      )}
    </>
  );
}
