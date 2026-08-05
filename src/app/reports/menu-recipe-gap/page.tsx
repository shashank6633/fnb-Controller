'use client';

/**
 * MENU RECIPE GAP (/reports/menu-recipe-gap) — management only.
 *
 * BREAK 4 of the traceability audit, made visible and closeable.
 *
 * Measured on the local copy of the production database on 2026-08-05:
 *
 *   menu_items                                     628
 *   menu_items with no recipe_id                   610
 *   sales rows                                   1,141
 *   sales rows carrying a recipe_id                  0
 *   revenue in `sales`                  ₹2,17,53,044.34
 *   recorded food cost against it                   ₹0
 *
 * A dish with no recipe records zero food cost and moves no stock. That is not
 * a reporting gap — it is the reason the variance report and the food-cost
 * percentage cannot be believed for most of the menu.
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
 * on a phone. If you move it, restyle it, or fold it into a tooltip, someone
 * will attach 200 recipes, watch last month's food cost stay at zero, and
 * report the deduction engine as broken. Leave it where it is.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE BUCKETS, THREE DIFFERENT THINGS, DELIBERATELY NOT ADDED
 * ═══════════════════════════════════════════════════════════════════════════
 * Same discipline as /reports/purchases → "Purchase log (itemwise)" and
 * /reports/issue-log: totals are stated PER BUCKET with the server's own basis
 * sentence, and there is no combined figure anywhere on this page or in the CSV.
 *
 *   1  SOLD, NO RECIPE          counts MENU ITEMS.  Revenue is measured, in the
 *                               window. This is the fixable, ranked list.
 *   2  NO RECIPE, NOT SOLD YET  counts MENU ITEMS.  Revenue is ₹0 BY DEFINITION
 *                               in this window — that is an absence of evidence,
 *                               not an absence of risk. These are the holes that
 *                               have not been walked into yet.
 *   3  SOLD, NOT ON THE MENU    counts SALES LINES. Not menu items. There is no
 *                               menu row to attach anything to, so nothing here
 *                               is tickable.
 *
 * The COUNTS cannot be added: menu items plus menu items plus sales lines is not
 * a number of anything. The revenue in 1 and 3 are disjoint slices of the same
 * `sales` table, so their sum is arithmetically real — and it is still the wrong
 * thing to quote, because half of it is fixable from this page and half of it
 * cannot be touched here at all. The reconciliation line under the headline
 * shows the slices adding back to the period total; that is the only place
 * addition happens, and it is labelled as a reconciliation, not a KPI.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE SALES→MENU LINK IS BY NAME, AND WHY BUCKET 3 EXISTS AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 * sales.pos_item_id is NULL on all 1,141 rows and menu_items.pos_id matches none
 * of them, so the only available join is a normalised name. It matches roughly
 * 510 of 1,141 rows. The rows it does NOT match are not dropped and are not
 * folded into the ranked list — they get their own labelled section, because a
 * ranked table that silently omits half the sales file would understate the gap
 * to exactly the person trying to size it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTHING IS APPLIED WITHOUT A TICK, AND THERE IS NO "TICK EVERYTHING"
 * ═══════════════════════════════════════════════════════════════════════════
 * The suggested recipe comes from src/lib/recipe-matcher.ts, which is fuzzy and
 * says so in its own header: it errs toward "no match" because a wrong link
 * pulls the WRONG food cost into every future sale of that dish, silently and
 * permanently. So:
 *
 *   · a row with no suggestion cannot be ticked — there is nothing to apply;
 *   · ticking is per row, and the POST sends only ticked pairs;
 *   · the ticked pairs are re-listed in a review panel and the attach button is
 *     only reachable from there, so the last thing before the write is the list
 *     of exactly what is about to be written;
 *   · there is deliberately NO "select all" / "accept all strong matches"
 *     control. One click that links 300 dishes to fuzzy-matched recipes is the
 *     unattended bulk path the design explicitly refused. Do not add it back as
 *     a convenience.
 *
 * The server is the real guard (admin-gated, only where recipe_id IS NULL, never
 * overwriting, one audit event per attach). This page is the honest surface in
 * front of it, and it reports the per-pair applied/skipped answer verbatim
 * instead of assuming the write did what was asked.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WIRE CONTRACT — GET/POST /api/reports/menu-recipe-gap
 * ═══════════════════════════════════════════════════════════════════════════
 * Mirrored here as local types rather than imported, so this page compiles
 * independently of the route's build order. The FIELD NAMES are the contract.
 *
 *   GET  ?from=YYYY-MM-DD&to=YYYY-MM-DD&format=json|csv   → GapResponse | CSV
 *   POST { pairs: [{ menu_item_id, recipe_id }] }         → AttachResponse
 *
 * Both gate on isManagement (401/403), same wording as /api/reports/issue-log.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { todayIST } from '@/lib/format-date';
import {
  ChefHat, Download, AlertTriangle, Info, Loader2, TrendingDown, CircleSlash,
  CalendarDays, Check, X, Link2, ListChecks, RefreshCw, Search, Ban,
} from 'lucide-react';

/* ═══════════════════════════════ WIRE CONTRACT ═══════════════════════════ */

/** The matcher's answer for one menu item. score is 0..1; `exact` is a
 *  normalised-name identity, which is the only kind of match that is not a
 *  guess. Anything else is a candidate for a human to read. */
interface RecipeSuggestion {
  recipe_id: string;
  recipe_name: string;
  score: number;
  exact: boolean;
}

interface GapItem {
  menu_item_id: string;
  name: string;
  category: string;
  item_code: string;
  selling_price: number | null;
  is_active: boolean;
  /** Units and revenue in the selected window, from the name-matched sales rows. */
  units_sold: number;
  revenue: number;
  /** YYYY-MM-DD of the most recent matched sale, or null if it never sold. */
  last_sold: string | null;
  suggestion: RecipeSuggestion | null;
}

/** A sales row whose item name matches no menu item. Nothing to attach to. */
interface OrphanSale {
  item_name: string;
  category: string;
  units_sold: number;
  revenue: number;
  last_sold: string | null;
  /** How many rows in `sales` collapsed into this name. */
  sale_lines: number;
}

/** One section's own figures. `basis` is printed VERBATIM under the heading —
 *  it is the only thing stopping three sections being read as three parts of
 *  one number. Never paraphrase it on screen. */
interface Bucket<T> {
  label: string;
  basis: string;
  /** What `lines` counts, in words: 'menu items' / 'sales lines'. */
  lines_unit: string;
  lines: number;
  units: number | null;
  revenue: number | null;
  rows: T[];
  truncated: boolean;
}

interface GapHeadline {
  menu_items_total: number;
  menu_items_without_recipe: number;
  sales_rows_total: number;
  sales_rows_with_recipe_id: number;
  sales_revenue_total: number;
  /** Revenue in the window whose menu item DOES carry a recipe. Present so the
   *  three slices can be shown reconciling to the period total. Optional. */
  sales_revenue_matched_with_recipe: number | null;
  basis: string;
}

interface GapResponse {
  from: string;
  to: string;
  headline: GapHeadline;
  sold_no_recipe: Bucket<GapItem>;
  unsold_no_recipe: Bucket<GapItem>;
  orphan_sales: Bucket<OrphanSale>;
}

/** One pair's fate, as the SERVER reports it. Never inferred from a 200. */
interface AttachResult {
  menu_item_id: string;
  name: string;
  recipe_id: string;
  recipe_name: string;
  outcome: 'applied' | 'skipped';
  /** Plain English on a skip: 'already linked', 'menu item not found', … */
  reason: string;
}

interface AttachResponse {
  results: AttachResult[];
  applied: number;
  skipped: number;
}

/* ══════════════════════════════════ format ═══════════════════════════════ */

const fmtINR = (n: number | null | undefined) =>
  '₹' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-IN');
const fmtNum = (n: number | null | undefined) => (Number(n) || 0).toLocaleString('en-IN');
/** Quantities sold are routinely fractional (0.5 portion) — do not round them away. */
const fmtQty = (n: number | null | undefined) =>
  (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

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

/** Empty shells so a bucket the server omits renders as "nothing here" rather
 *  than crashing the page. A partial payload must degrade, not blank out. */
function emptyBucket<T>(label: string, linesUnit: string): Bucket<T> {
  return { label, basis: '', lines_unit: linesUnit, lines: 0, units: 0, revenue: 0, rows: [], truncated: false };
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
      const j = (await res.json()) as GapResponse;
      setData({
        ...j,
        sold_no_recipe: j.sold_no_recipe || emptyBucket<GapItem>('Sold, no recipe', 'menu items'),
        unsold_no_recipe: j.unsold_no_recipe || emptyBucket<GapItem>('No recipe, not sold in this window', 'menu items'),
        orphan_sales: j.orphan_sales || emptyBucket<OrphanSale>('Sold, not on the menu master', 'sales lines'),
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

  const sold = data?.sold_no_recipe || emptyBucket<GapItem>('Sold, no recipe', 'menu items');
  const unsold = data?.unsold_no_recipe || emptyBucket<GapItem>('No recipe, not sold in this window', 'menu items');
  const orphans = data?.orphan_sales || emptyBucket<OrphanSale>('Sold, not on the menu master', 'sales lines');

  /**
   * RANKING. Revenue descending, always — the point of this report is "fix the
   * biggest holes first", and the server already returns it in that order. The
   * client re-sorts anyway so a text filter or a stale payload can never quietly
   * reorder the list into something that looks ranked but is not.
   */
  const soldRows = useMemo(() => {
    const rows = [...(sold.rows || [])];
    rows.sort((a, b) => (Number(b.revenue) || 0) - (Number(a.revenue) || 0)
      || (Number(b.units_sold) || 0) - (Number(a.units_sold) || 0)
      || String(a.name).localeCompare(String(b.name)));
    return qLive ? rows.filter(r => matchesQuery(r, qLive)) : rows;
  }, [sold.rows, qLive]);

  const unsoldRows = useMemo(() => {
    const rows = [...(unsold.rows || [])];
    rows.sort((a, b) => String(a.category || '').localeCompare(String(b.category || ''))
      || String(a.name).localeCompare(String(b.name)));
    return qLive ? rows.filter(r => matchesQuery(r, qLive)) : rows;
  }, [unsold.rows, qLive]);

  const orphanRows = useMemo(() => {
    const rows = [...(orphans.rows || [])];
    rows.sort((a, b) => (Number(b.revenue) || 0) - (Number(a.revenue) || 0)
      || String(a.item_name).localeCompare(String(b.item_name)));
    return qLive
      ? rows.filter(r => `${r.item_name} ${r.category}`.toLowerCase().includes(qLive))
      : rows;
  }, [orphans.rows, qLive]);

  /** The ticked pairs, resolved back to names for the review panel. Built from
   *  the loaded rows so a tick whose row has vanished (window changed under the
   *  user) is dropped here rather than posted blind. */
  const tickedPairs = useMemo(() => {
    const byId = new Map<string, GapItem>();
    for (const r of [...(sold.rows || []), ...(unsold.rows || [])]) byId.set(r.menu_item_id, r);
    const out: { item: GapItem; recipe_id: string; recipe_name: string; score: number; exact: boolean }[] = [];
    for (const [menuItemId, recipeId] of Object.entries(ticked)) {
      const item = byId.get(menuItemId);
      if (!item || !item.suggestion) continue;
      // The tick recorded a SPECIFIC recipe. If the reloaded suggestion is a
      // different recipe, the acceptance no longer describes what is on screen —
      // drop it rather than silently apply the new one.
      if (item.suggestion.recipe_id !== recipeId) continue;
      out.push({ item, recipe_id: recipeId, recipe_name: item.suggestion.recipe_name, score: item.suggestion.score, exact: item.suggestion.exact });
    }
    out.sort((a, b) => (Number(b.item.revenue) || 0) - (Number(a.item.revenue) || 0));
    return out;
  }, [ticked, sold.rows, unsold.rows]);

  const toggleTick = (item: GapItem) => {
    if (!item.suggestion) return;              // nothing to accept
    setAttachResults(null); setAttachError('');
    setTicked(prev => {
      const next = { ...prev };
      if (next[item.menu_item_id]) delete next[item.menu_item_id];
      else next[item.menu_item_id] = item.suggestion!.recipe_id;
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
        applied: Number(j.applied ?? results.filter(r => r.outcome === 'applied').length),
        skipped: Number(j.skipped ?? results.filter(r => r.outcome !== 'applied').length),
      });
      // Only the pairs the SERVER says it applied stop being pending. A skipped
      // pair keeps its tick so the reason stays next to a row the user can act on.
      const applied = new Set(results.filter(r => r.outcome === 'applied').map(r => r.menu_item_id));
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

  const headline = data?.headline;
  const covered = headline ? Math.max(0, headline.menu_items_total - headline.menu_items_without_recipe) : 0;

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
          file header before moving, shrinking or collapsing this.
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
        </div>

        {/* The measured headline, plainly. */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatCard
              icon={<CircleSlash className="w-4 h-4" />}
              label="Menu items with no recipe"
              value={headline ? `${fmtNum(headline.menu_items_without_recipe)} of ${fmtNum(headline.menu_items_total)}` : '—'}
              sub={headline ? `${fmtNum(covered)} carry a recipe. A dish with no recipe records zero food cost and moves no stock.` : 'Loading…'}
            />
            <StatCard
              icon={<Link2 className="w-4 h-4" />}
              label="Sales rows carrying a recipe id"
              value={headline ? `${fmtNum(headline.sales_rows_with_recipe_id)} of ${fmtNum(headline.sales_rows_total)}` : '—'}
              sub={headline ? 'The recipe id is snapshotted onto the sale row. A row without one recorded no cost and deducted nothing.' : 'Loading…'}
            />
            <StatCard
              icon={<TrendingDown className="w-4 h-4" />}
              label="Sales revenue with no recorded food cost"
              value={headline ? fmtINR(headline.sales_revenue_total - (headline.sales_revenue_matched_with_recipe || 0)) : '—'}
              sub={headline ? `Out of ${fmtINR(headline.sales_revenue_total)} in this table for the selected window.` : 'Loading…'}
              alarm
            />
          </div>

          {/* The baseline this page was written against — kept because a future
              reader needs to know whether the gap is closing or the window is
              just smaller. It is a stated measurement, not a live figure. */}
          <p className="text-[11px] text-[#8B7355] leading-relaxed">
            <strong>Measured on 2026-08-05, whole database:</strong> 610 of 628 menu items had no recipe, and{' '}
            <strong>every one of the 1,141 rows in <code className="font-mono">sales</code> carried no recipe id</strong> —
            so ₹0 of food cost had been recorded against ₹2,17,53,044.34 of sales in that table. The cards above are for
            the selected window; this sentence is the whole-database baseline.
          </p>
          {headline?.basis && <p className="text-[11px] text-[#8B7355] leading-relaxed">{headline.basis}</p>}

          {/* The ONLY addition on this page, and it is labelled as a
              reconciliation of one table's revenue — not a headline number. */}
          {headline && headline.sales_revenue_matched_with_recipe != null && (
            <p className="text-[11px] text-[#6B5744] leading-relaxed border-t border-[#F0E4D6] pt-2">
              <strong>Reconciliation</strong> (revenue only, this window):{' '}
              {fmtINR(sold.revenue)} sold-with-no-recipe + {fmtINR(orphans.revenue)} not-on-the-menu-master +{' '}
              {fmtINR(headline.sales_revenue_matched_with_recipe)} on items that do carry a recipe ={' '}
              {fmtINR(headline.sales_revenue_total)} total. The three <em>section counts</em> below still cannot be added —
              two of them count menu items and one counts sales lines.
            </p>
          )}
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

            <label className="block min-w-[200px] flex-1"><span className="text-[11px] font-semibold text-[#8B7355] uppercase">Find</span>
              <span className="mt-1 flex items-center gap-2 px-3 py-2 rounded-lg border border-[#E0D0BE] bg-white focus-within:border-[#af4408]">
                <Search className="w-3.5 h-3.5 text-[#B8A48E] shrink-0" />
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="Dish, category or code…"
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

        {/* The three-buckets warning, between the filters and the first section. */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900 flex gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <p>
            <strong>The three sections below count different things — do not add them.</strong>{' '}
            Sections 1 and 2 count <strong>menu items</strong>. Section 3 counts <strong>sales lines</strong> that match no
            menu item at all. Section 2 shows ₹0 because nothing sold in this window, which is an absence of evidence, not
            an absence of risk. Only sections 1 and 2 can be fixed from this page — section 3 has no menu row to attach a
            recipe to.
          </p>
        </div>

        {/* ── SECTION 1: sold, no recipe. The ranked, fixable list. ── */}
        <BucketShell
          n={1}
          title="Sold, and no recipe attached"
          bucket={sold}
          shown={soldRows.length}
          fixable
          loading={loading}
        >
          <GapTable
            rows={soldRows}
            showSales
            paintAll={!!paintAll.sold}
            onPaintAll={() => setPaintAll(p => ({ ...p, sold: true }))}
            ticked={ticked}
            onToggle={toggleTick}
            emptyText={loading ? 'Loading…' : error ? 'Not loaded — see the message above.' : 'Nothing sold in this window without a recipe. That is the good answer.'}
          />
        </BucketShell>

        {/* ── SECTION 2: no recipe, no sales in the window. ── */}
        <BucketShell
          n={2}
          title="No recipe, and nothing sold in this window"
          bucket={unsold}
          shown={unsoldRows.length}
          fixable
          loading={loading}
        >
          <GapTable
            rows={unsoldRows}
            showSales={false}
            paintAll={!!paintAll.unsold}
            onPaintAll={() => setPaintAll(p => ({ ...p, unsold: true }))}
            ticked={ticked}
            onToggle={toggleTick}
            emptyText={loading ? 'Loading…' : error ? 'Not loaded — see the message above.' : 'Every unlinked menu item sold at least once in this window.'}
          />
        </BucketShell>

        {/* ── SECTION 3: sold, not on the menu master. Nothing to attach. ── */}
        <BucketShell
          n={3}
          title="Sold, but not on the menu master"
          bucket={orphans}
          shown={orphanRows.length}
          fixable={false}
          loading={loading}
        >
          <div className="text-[11px] text-[#6B5744] bg-[#FDF6EF] border border-[#F0E4D6] rounded-lg px-3 py-2 mb-3 flex gap-2">
            <Ban className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[#B8A48E]" />
            <span>
              These sales rows match no menu item by name, so there is no menu row here to attach a recipe to and nothing
              in this section is tickable. <strong>sales.pos_item_id is NULL on every row</strong> and menu_items.pos_id
              matches none of them, so the only link available is a normalised name. Fix these by adding the dish to the
              menu master (or correcting its name), then it appears in section 1 or 2 above.
            </span>
          </div>
          <OrphanTable
            rows={orphanRows}
            paintAll={!!paintAll.orphan}
            onPaintAll={() => setPaintAll(p => ({ ...p, orphan: true }))}
            emptyText={loading ? 'Loading…' : error ? 'Not loaded — see the message above.' : 'Every sales row in this window matched a menu item by name.'}
          />
        </BucketShell>

        {/* How to read it. */}
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

            <div className="overflow-y-auto px-4 sm:px-5 py-3 flex-1">
              <ul className="divide-y divide-[#F7EEE3]">
                {tickedPairs.map(p => (
                  <li key={p.item.menu_item_id} className="py-2 flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-[#2D1B0E] break-words">{p.item.name}</p>
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
             has to see which one and why. ── */}
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
            </div>
            <div className="overflow-y-auto px-4 sm:px-5 py-3 flex-1">
              <ul className="divide-y divide-[#F7EEE3]">
                {attachResults.results.map((r, i) => (
                  <li key={`${r.menu_item_id}-${i}`} className="py-2 flex items-start gap-2">
                    {r.outcome === 'applied'
                      ? <Check className="w-4 h-4 text-[#3F6B4C] shrink-0 mt-0.5" />
                      : <CircleSlash className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />}
                    <div className="min-w-0">
                      <p className="text-sm text-[#2D1B0E] break-words">{r.name || r.menu_item_id}</p>
                      <p className="text-[11px] text-[#8B7355] break-words">
                        {r.outcome === 'applied'
                          ? <>linked to <span className="text-[#3F6B4C] font-medium">{r.recipe_name || r.recipe_id}</span></>
                          : <span className="text-amber-800">skipped — {r.reason || 'no reason given by the server'}</span>}
                      </p>
                    </div>
                  </li>
                ))}
                {attachResults.results.length === 0 && (
                  <li className="py-3 text-sm text-[#8B7355]">The server returned no per-pair result. Nothing can be confirmed from here — reload and check the items.</li>
                )}
              </ul>
            </div>
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

function matchesQuery(r: GapItem, needle: string) {
  return `${r.name} ${r.category} ${r.item_code} ${r.suggestion?.recipe_name || ''}`.toLowerCase().includes(needle);
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
 * One bucket, with its own count, its own money, and the server's own `basis`
 * sentence printed verbatim. The number is captioned with WHAT it counts
 * ("menu items" / "sales lines") because that caption is the whole reason the
 * three sections cannot be added.
 */
function BucketShell({ n, title, bucket, shown, fixable, loading, children }: {
  n: number; title: string; bucket: Bucket<unknown>; shown: number; fixable: boolean; loading: boolean;
  children: React.ReactNode;
}) {
  const unitWord = bucket.lines_unit || (fixable ? 'menu items' : 'sales lines');
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
          {fmtNum(bucket.lines)} <span className="text-xs font-semibold text-[#8B7355]">{unitWord}</span>
        </span>
        {bucket.revenue != null && (
          <span className="text-sm text-[#6B5744]">
            {fixable ? 'Revenue in window' : 'Revenue on these lines'} <strong>{fmtINR(bucket.revenue)}</strong>
          </span>
        )}
        {bucket.units != null && bucket.units > 0 && (
          <span className="text-xs text-[#8B7355]">{fmtQty(bucket.units)} units sold</span>
        )}
        {shown !== bucket.lines && (
          <span className="text-[11px] text-[#B8A48E]">showing {fmtNum(shown)} after search</span>
        )}
      </div>

      <p className="text-[11px] text-[#8B7355] mb-3 whitespace-normal leading-snug">
        {bucket.basis || (fixable
          ? 'Counts menu items. Not comparable with the sales-line count in section 3.'
          : 'Counts sales lines, not menu items. Not comparable with the item counts in sections 1 and 2.')}
      </p>

      {bucket.truncated && (
        <div className="bg-[#af4408] text-white rounded-lg px-3 py-2 text-xs font-semibold flex items-start gap-2 mb-3">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>The server TRUNCATED this section — it is not the full list. Narrow the window or download the CSV, which contains every row.</span>
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

function GapTable({ rows, showSales, paintAll, onPaintAll, ticked, onToggle, emptyText }: {
  rows: GapItem[]; showSales: boolean; paintAll: boolean; onPaintAll: () => void;
  ticked: Record<string, string>; onToggle: (r: GapItem) => void; emptyText: string;
}) {
  const limit = paintAll ? rows.length : ROW_PAINT_CAP;
  const cols = showSales ? 7 : 5;
  return (
    <>
      {/* The table scrolls inside THIS container. The page body must never
          scroll horizontally on a phone — hence overflow-x-hidden on the page
          shell and overflow-x-auto only here. */}
      <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
        <table className="w-full text-sm whitespace-nowrap">
          <thead><tr className="text-left text-[11px] uppercase text-[#8B7355] border-b border-[#F0E4D6]">
            <th className="py-2 pr-2 w-8"><span className="sr-only">Accept suggestion</span></th>
            <th className="py-2 px-3">Menu item</th>
            <th className="py-2 px-3">Category</th>
            {showSales && <th className="py-2 px-3 text-right">Units</th>}
            {showSales && <th className="py-2 px-3 text-right">Revenue</th>}
            {showSales && <th className="py-2 px-3">Last sold</th>}
            <th className="py-2 pl-3">Suggested recipe</th>
          </tr></thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={cols} className="py-6 text-center text-[#8B7355]">{emptyText}</td></tr>
            ) : rows.slice(0, limit).map(r => {
              const isTicked = !!ticked[r.menu_item_id];
              return (
                <tr key={r.menu_item_id} className={`border-b border-[#F7EEE3] last:border-0 align-top ${isTicked ? 'bg-[#FFF6EE]' : ''}`}>
                  <td className="py-2 pr-2">
                    {/* No suggestion ⇒ no tick. There is nothing to accept, and a
                        checkbox that does nothing invites a bulk selection that
                        silently applies fewer pairs than it appears to. */}
                    <input
                      type="checkbox"
                      className="accent-[#af4408] w-4 h-4 disabled:opacity-30"
                      checked={isTicked}
                      disabled={!r.suggestion}
                      onChange={() => onToggle(r)}
                      aria-label={r.suggestion ? `Attach ${r.suggestion.recipe_name} to ${r.name}` : `${r.name} has no suggested recipe`}
                    />
                  </td>
                  <td className="py-2 px-3 font-medium whitespace-normal min-w-[180px]">
                    {r.name || '—'}
                    <span className="block text-[10px] text-[#8B7355] font-normal">
                      {r.item_code ? `${r.item_code} · ` : ''}
                      {r.selling_price != null ? fmtINR(r.selling_price) : 'no price'}
                      {!r.is_active ? ' · inactive' : ''}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-[#6B5744] whitespace-normal min-w-[110px]">{r.category || '—'}</td>
                  {showSales && <td className="py-2 px-3 text-right tabular-nums">{fmtQty(r.units_sold)}</td>}
                  {showSales && <td className="py-2 px-3 text-right tabular-nums font-semibold">{fmtINR(r.revenue)}</td>}
                  {showSales && <td className="py-2 px-3 text-[#6B5744]">{r.last_sold || '—'}</td>}
                  <td className="py-2 pl-3 whitespace-normal min-w-[210px]">
                    {r.suggestion ? (
                      <>
                        <span className="text-[#2D1B0E]">{r.suggestion.recipe_name}</span>{' '}
                        <ScoreBadge score={r.suggestion.score} exact={r.suggestion.exact} />
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

function OrphanTable({ rows, paintAll, onPaintAll, emptyText }: {
  rows: OrphanSale[]; paintAll: boolean; onPaintAll: () => void; emptyText: string;
}) {
  const limit = paintAll ? rows.length : ROW_PAINT_CAP;
  return (
    <>
      <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
        <table className="w-full text-sm whitespace-nowrap">
          <thead><tr className="text-left text-[11px] uppercase text-[#8B7355] border-b border-[#F0E4D6]">
            <th className="py-2 pr-3">Sold as</th>
            <th className="py-2 px-3">Category</th>
            <th className="py-2 px-3 text-right">Sales lines</th>
            <th className="py-2 px-3 text-right">Units</th>
            <th className="py-2 px-3 text-right">Revenue</th>
            <th className="py-2 pl-3">Last sold</th>
          </tr></thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={6} className="py-6 text-center text-[#8B7355]">{emptyText}</td></tr>
            ) : rows.slice(0, limit).map((r, i) => (
              <tr key={`${r.item_name}-${i}`} className="border-b border-[#F7EEE3] last:border-0 align-top">
                <td className="py-2 pr-3 font-medium whitespace-normal min-w-[180px]">{r.item_name || '—'}</td>
                <td className="py-2 px-3 text-[#6B5744] whitespace-normal min-w-[110px]">{r.category || '—'}</td>
                <td className="py-2 px-3 text-right tabular-nums">{fmtNum(r.sale_lines)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{fmtQty(r.units_sold)}</td>
                <td className="py-2 px-3 text-right tabular-nums font-semibold">{fmtINR(r.revenue)}</td>
                <td className="py-2 pl-3 text-[#6B5744]">{r.last_sold || '—'}</td>
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
