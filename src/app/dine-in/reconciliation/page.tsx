'use client';

/**
 * Dine-In Reconciliation — surfaces every break in the chain
 * POS sales → menu item → recipe → ingredients.
 *
 * Each broken step inflates / hides true food cost %, so this page
 * exists to give the controller a one-screen "what's lying to me?"
 * view with one-click fix shortcuts.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ChevronDown, ChevronRight, CheckCircle2, Loader2,
  RefreshCw, Link2, Plus, ChefHat, Package, ArrowRight,
} from 'lucide-react';

const fmt = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');
const today = () => new Date().toISOString().slice(0, 10);
const minusDays = (n: number) => {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

interface UnmatchedSale {
  item_name: string;
  qty_sold: number;
  revenue: number;
  line_count: number;
  suggested_match: { menu_item_id: string; name: string; score: number } | null;
}
interface MenuNoRecipe {
  id: string; name: string; category: string;
  sales_qty: number; sales_revenue: number; item_code: string;
  suggested_action: 'add_recipe' | 'mark_direct';
}
interface EmptyRecipe {
  recipe_id: string; recipe_name: string; menu_items: string[];
  sales_qty: number; sales_revenue: number;
}
interface ZeroCostRecipe {
  recipe_id: string; recipe_name: string; ingredient_count: number;
  sales_qty: number; sales_revenue: number; priceless_ingredients: string[];
}

interface Resp {
  date_range: { from: string; to: string };
  summary: {
    total_issues: number;
    by_category: {
      unmatched_sales: number;
      menu_no_recipe: number;
      empty_recipes: number;
      zero_cost_recipes: number;
    };
    healthy_count: number;
    healthy_revenue: number;
    problematic_revenue: number;
  };
  unmatched_sales: UnmatchedSale[];
  menu_no_recipe: MenuNoRecipe[];
  empty_recipes: EmptyRecipe[];
  zero_cost_recipes: ZeroCostRecipe[];
}

export default function DineInReconciliationPage() {
  const [from, setFrom] = useState(minusDays(30));
  const [to, setTo]     = useState(today());
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Per-section open state — initialized after fetch (open if count > 0)
  const [open, setOpen] = useState<Record<string, boolean>>({
    unmatched_sales: true,
    menu_no_recipe:  true,
    empty_recipes:   true,
    zero_cost_recipes: true,
  });

  const reload = async () => {
    setLoading(true); setError('');
    try {
      const qs = new URLSearchParams({ from, to });
      const r = await fetch(`/api/dine-in/reconciliation?${qs}`);
      if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
      const d: Resp = await r.json();
      setData(d);
      setOpen({
        unmatched_sales:   d.summary.by_category.unmatched_sales   > 0,
        menu_no_recipe:    d.summary.by_category.menu_no_recipe    > 0,
        empty_recipes:     d.summary.by_category.empty_recipes     > 0,
        zero_cost_recipes: d.summary.by_category.zero_cost_recipes > 0,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [from, to]);

  const honestPct = useMemo(() => {
    if (!data) return 0;
    const total = data.summary.healthy_revenue + data.summary.problematic_revenue;
    if (total <= 0) return 100;
    return Math.round((data.summary.healthy_revenue / total) * 100);
  }, [data]);

  const toggle = (k: string) => setOpen(o => ({ ...o, [k]: !o[k] }));

  return (
    <div className="p-6 space-y-5 min-h-screen" style={{ background: '#FFF8F0' }}>
      {/* Header */}
      <div className="flex items-start gap-3">
        <AlertTriangle className="text-[#af4408] mt-0.5" size={26} />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-[#2D1B0E]">Dine-In Reconciliation</h1>
          <p className="text-xs text-[#8B7355] mt-0.5">
            Every break in the sales → menu → recipe → cost chain that&rsquo;s making your food cost % lie.
          </p>
        </div>
        <button
          onClick={reload}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#FFF1E3] hover:bg-[#F5EDE2] disabled:opacity-60 text-[#2D1B0E] rounded text-sm"
        >
          {loading ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />} Rescan
        </button>
      </div>

      {/* Date range */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 flex flex-wrap items-center gap-3">
        <label className="text-xs text-[#6B5744] flex items-center gap-2">
          From
          <input
            type="date" value={from} onChange={e => setFrom(e.target.value)}
            className="px-2 py-1 border border-[#D4B896] rounded text-sm bg-white"
          />
        </label>
        <label className="text-xs text-[#6B5744] flex items-center gap-2">
          To
          <input
            type="date" value={to} onChange={e => setTo(e.target.value)}
            className="px-2 py-1 border border-[#D4B896] rounded text-sm bg-white"
          />
        </label>
        {loading && (
          <span className="inline-flex items-center gap-1.5 text-xs text-[#8B7355]">
            <Loader2 className="animate-spin" size={12} /> Scanning sales chain&hellip;
          </span>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded p-3 text-sm flex items-center justify-between gap-3">
          <span>Failed to load: {error}</span>
          <button
            onClick={reload}
            className="px-3 py-1 bg-red-100 hover:bg-red-200 rounded text-xs font-medium"
          >Retry</button>
        </div>
      )}

      {/* KPI tiles */}
      {data && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="text-emerald-600" size={16} />
              <div className="text-[10px] uppercase tracking-wide text-emerald-700 font-semibold">
                Healthy chain
              </div>
            </div>
            <div className="mt-2 text-2xl font-bold text-[#2D1B0E]">
              {data.summary.healthy_count.toLocaleString('en-IN')}
              <span className="text-xs font-normal text-[#8B7355] ml-1">sales rows</span>
            </div>
            <div className="text-sm text-emerald-700 font-medium mt-1">
              {fmt(data.summary.healthy_revenue)}
            </div>
          </div>

          <div className="bg-white border border-amber-300 rounded-xl p-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="text-amber-600" size={16} />
              <div className="text-[10px] uppercase tracking-wide text-amber-700 font-semibold">
                Problematic
              </div>
            </div>
            <div className="mt-2 text-2xl font-bold text-[#2D1B0E]">
              {data.summary.total_issues.toLocaleString('en-IN')}
              <span className="text-xs font-normal text-[#8B7355] ml-1">issues</span>
            </div>
            <div className="text-sm text-red-700 font-medium mt-1">
              {fmt(data.summary.problematic_revenue)}
              <span className="text-xs text-[#8B7355] font-normal ml-1">flowing through broken chain</span>
            </div>
          </div>

          <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 flex items-center gap-4">
            <div className="relative w-20 h-20 shrink-0">
              <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                <circle cx="18" cy="18" r="15.9" fill="none" stroke="#FFF1E3" strokeWidth="3.5" />
                <circle
                  cx="18" cy="18" r="15.9" fill="none"
                  stroke={honestPct >= 90 ? '#059669' : honestPct >= 70 ? '#d97706' : '#dc2626'}
                  strokeWidth="3.5" strokeDasharray="100 100"
                  strokeDashoffset={100 - honestPct} pathLength={100}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-lg font-bold text-[#2D1B0E]">{honestPct}%</span>
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] uppercase tracking-wide text-[#8B7355] font-semibold">
                % Honest revenue
              </div>
              <div className="text-xs text-[#6B5744] mt-1">
                Share of revenue whose food cost can be trusted.
              </div>
              <div className="text-[10px] text-[#8B7355] mt-1">
                {fmt(data.summary.healthy_revenue)} clean / {fmt(data.summary.healthy_revenue + data.summary.problematic_revenue)} total
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Sections */}
      {data && (
        <div className="space-y-3">
          {/* Section 1: Unmatched sales */}
          <Section
            title="Unmatched Sales"
            count={data.summary.by_category.unmatched_sales}
            isOpen={open.unmatched_sales}
            onToggle={() => toggle('unmatched_sales')}
            description="POS line items that don't match any menu item — sales we can't even attribute."
          >
            {data.unmatched_sales.length === 0 ? (
              <Clean />
            ) : (
              <ul className="divide-y divide-[#E8D5C4]/60">
                {data.unmatched_sales.map((r, idx) => (
                  <li key={idx} className="px-4 py-3 hover:bg-[#FFF8F0]/60">
                    <div className="flex flex-wrap items-start gap-3 justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-[#2D1B0E]">{r.item_name}</div>
                        <div className="text-xs text-[#6B5744] mt-0.5">
                          {r.qty_sold.toLocaleString('en-IN')} qty &times; {fmt(r.revenue)}
                          <span className="text-[#8B7355]"> &middot; {r.line_count} POS line{r.line_count === 1 ? '' : 's'}</span>
                        </div>
                        {r.suggested_match && r.suggested_match.score > 0.7 ? (
                          <div className="text-[11px] text-emerald-700 mt-1">
                            Suggested match: <strong>{r.suggested_match.name}</strong>{' '}
                            <span className="text-[#8B7355]">({Math.round(r.suggested_match.score * 100)}% confidence)</span>
                          </div>
                        ) : (
                          <div className="text-[11px] text-[#8B7355] mt-1 italic">No suggestion</div>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {r.suggested_match && r.suggested_match.score > 0.7 && (
                          <button
                            className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white"
                            title={`Link to ${r.suggested_match.name}`}
                          >
                            <Link2 size={11} /> Link as suggested
                          </button>
                        )}
                        <a
                          href={`/menu-items?search=${encodeURIComponent(r.item_name)}`}
                          className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-[#FFF1E3] hover:bg-[#F5EDE2] text-[#2D1B0E] border border-[#E8D5C4]"
                        >
                          <Link2 size={11} /> Link to existing
                        </a>
                        <a
                          href={`/menu-items?new=${encodeURIComponent(r.item_name)}`}
                          className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-[#af4408] hover:bg-[#8e3506] text-white"
                        >
                          <Plus size={11} /> Create new
                        </a>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* Section 2: Menu items linked to sales but no recipe */}
          <Section
            title="Menu items selling but no recipe"
            count={data.summary.by_category.menu_no_recipe}
            isOpen={open.menu_no_recipe}
            onToggle={() => toggle('menu_no_recipe')}
            description="POS attributes sales here, but with no recipe the food cost is fake."
          >
            {data.menu_no_recipe.length === 0 ? (
              <Clean />
            ) : (
              <ul className="divide-y divide-[#E8D5C4]/60">
                {data.menu_no_recipe.map(r => (
                  <li key={r.id} className="px-4 py-3 hover:bg-[#FFF8F0]/60">
                    <div className="flex flex-wrap items-start gap-3 justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-[#2D1B0E]">{r.name}</span>
                          {r.category && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#FFF1E3] text-[#6B5744] border border-[#E8D5C4]">
                              {r.category}
                            </span>
                          )}
                          {r.item_code && (
                            <span className="text-[10px] text-[#8B7355]">#{r.item_code}</span>
                          )}
                        </div>
                        <div className="text-xs text-[#6B5744] mt-0.5">
                          {r.sales_qty.toLocaleString('en-IN')} qty &times; {fmt(r.sales_revenue)}
                        </div>
                        <div className="text-[11px] mt-1 inline-flex items-center gap-1 text-red-700 bg-red-50 px-1.5 py-0.5 rounded border border-red-200">
                          <AlertTriangle size={11} /> ₹0 cost &middot; 100% FAKE FC
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <a
                          href="/recipes"
                          className={`inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded ${
                            r.suggested_action === 'add_recipe'
                              ? 'bg-[#af4408] hover:bg-[#8e3506] text-white'
                              : 'bg-[#FFF1E3] hover:bg-[#F5EDE2] text-[#2D1B0E] border border-[#E8D5C4]'
                          }`}
                        >
                          <ChefHat size={11} /> Add recipe <ArrowRight size={10} />
                        </a>
                        <a
                          href={`/direct-items?search=${encodeURIComponent(r.name)}`}
                          className={`inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded ${
                            r.suggested_action === 'mark_direct'
                              ? 'bg-[#af4408] hover:bg-[#8e3506] text-white'
                              : 'bg-[#FFF1E3] hover:bg-[#F5EDE2] text-[#2D1B0E] border border-[#E8D5C4]'
                          }`}
                        >
                          <Package size={11} /> Mark as direct <ArrowRight size={10} />
                        </a>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* Section 3: Empty recipes */}
          <Section
            title="Recipes linked but empty"
            count={data.summary.by_category.empty_recipes}
            isOpen={open.empty_recipes}
            onToggle={() => toggle('empty_recipes')}
            description="A recipe exists, but it has zero ingredients — so cost is structurally zero."
          >
            {data.empty_recipes.length === 0 ? (
              <Clean />
            ) : (
              <ul className="divide-y divide-[#E8D5C4]/60">
                {data.empty_recipes.map(r => {
                  const head = r.menu_items.slice(0, 3);
                  const extra = Math.max(0, r.menu_items.length - 3);
                  return (
                    <li key={r.recipe_id} className="px-4 py-3 hover:bg-[#FFF8F0]/60">
                      <div className="flex flex-wrap items-start gap-3 justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-[#2D1B0E]">{r.recipe_name}</div>
                          <div className="text-xs text-[#6B5744] mt-0.5">
                            Linked to: {head.join(', ') || '—'}
                            {extra > 0 && (
                              <span className="text-[#8B7355]"> +{extra} more</span>
                            )}
                          </div>
                          <div className="text-xs text-[#6B5744] mt-0.5">
                            {r.sales_qty.toLocaleString('en-IN')} qty &times; {fmt(r.sales_revenue)}
                          </div>
                        </div>
                        <a
                          href="/recipes"
                          className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-[#af4408] hover:bg-[#8e3506] text-white"
                        >
                          <ChefHat size={11} /> Open recipe to add ingredients <ArrowRight size={10} />
                        </a>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          {/* Section 4: Zero-cost recipes */}
          <Section
            title="Recipes with zero cost"
            count={data.summary.by_category.zero_cost_recipes}
            isOpen={open.zero_cost_recipes}
            onToggle={() => toggle('zero_cost_recipes')}
            description="Ingredients are listed but have no price — so the recipe still costs ₹0."
          >
            {data.zero_cost_recipes.length === 0 ? (
              <Clean />
            ) : (
              <ul className="divide-y divide-[#E8D5C4]/60">
                {data.zero_cost_recipes.map(r => (
                  <li key={r.recipe_id} className="px-4 py-3 hover:bg-[#FFF8F0]/60">
                    <div className="flex flex-wrap items-start gap-3 justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-[#2D1B0E]">{r.recipe_name}</div>
                        <div className="text-xs text-[#6B5744] mt-0.5">
                          {r.ingredient_count} ingredient{r.ingredient_count === 1 ? '' : 's'} &middot;{' '}
                          {r.sales_qty.toLocaleString('en-IN')} qty &times; {fmt(r.sales_revenue)}
                        </div>
                        {r.priceless_ingredients.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {r.priceless_ingredients.slice(0, 8).map(name => (
                              <span
                                key={name}
                                className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200"
                              >
                                {name}
                              </span>
                            ))}
                            {r.priceless_ingredients.length > 8 && (
                              <span className="text-[10px] text-[#8B7355]">
                                +{r.priceless_ingredients.length - 8} more
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <a
                          href="/recipes"
                          className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-[#FFF1E3] hover:bg-[#F5EDE2] text-[#2D1B0E] border border-[#E8D5C4]"
                        >
                          <ChefHat size={11} /> Open recipe <ArrowRight size={10} />
                        </a>
                        <a
                          href={`/inventory?search=${encodeURIComponent(r.priceless_ingredients[0] || '')}`}
                          className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-[#af4408] hover:bg-[#8e3506] text-white"
                        >
                          <Package size={11} /> Open ingredient prices <ArrowRight size={10} />
                        </a>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}

      {/* Loading skeleton when no data yet */}
      {!data && loading && !error && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-10 text-center text-sm text-[#8B7355]">
          <Loader2 className="animate-spin inline mr-2" size={14} />
          Scanning sales chain&hellip;
        </div>
      )}
    </div>
  );
}

/* ─────────── helpers ─────────── */

function Section({
  title, count, isOpen, onToggle, description, children,
}: {
  title: string;
  count: number;
  isOpen: boolean;
  onToggle: () => void;
  description: string;
  children: React.ReactNode;
}) {
  const tone = count > 0
    ? 'bg-amber-100 text-amber-800 border-amber-200'
    : 'bg-emerald-100 text-emerald-700 border-emerald-200';
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[#FFF8F0]/60 text-left"
      >
        {isOpen ? <ChevronDown size={16} className="text-[#6B5744]" /> : <ChevronRight size={16} className="text-[#6B5744]" />}
        <AlertTriangle
          size={15}
          className={count > 0 ? 'text-amber-600' : 'text-emerald-600'}
        />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-[#2D1B0E]">{title}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${tone}`}>
              {count}
            </span>
          </div>
          <div className="text-[11px] text-[#8B7355] mt-0.5">{description}</div>
        </div>
      </button>
      {isOpen && <div className="border-t border-[#E8D5C4]">{children}</div>}
    </div>
  );
}

function Clean() {
  return (
    <div className="px-4 py-6 text-center text-sm text-emerald-700 bg-emerald-50/40">
      <CheckCircle2 className="inline mr-1" size={14} /> All clean!
    </div>
  );
}
