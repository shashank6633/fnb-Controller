'use client';

/**
 * QUICK RECIPE — a real recipe, entered in under a minute.
 * -------------------------------------------------------
 * 479 live menu items on this data have no recipe. 146 of them are FOOD items
 * that actually sold — ₹44.8 L of revenue booked at ZERO food cost, because the
 * only way to cost a dish was the full recipe editor: every ingredient, every
 * yield, every wastage percentage, a method. Nobody was ever going to do that
 * 146 times, so it was never done at all and the dishes stayed at ₹0.
 *
 * This screen asks for the only thing that actually moves a food cost: the few
 * expensive materials. Paneer. Chicken. Mutton. Prawns. Paya. Bheja. Broccoli.
 * Tick them, type roughly how much of each, save. No method, no yield, no
 * wastage — the columns keep their defaults (100% / 0%), which is exactly what
 * every one of the 67 existing recipes already carries.
 *
 * WHAT THIS IS NOT: a draft, a stub, or a second kind of object. It writes a row
 * to `recipes` through POST /api/recipes — the same endpoint, the same costing,
 * the same menu link as the full editor. The only difference on disk is
 * is_approximate = 1. So it can be COMPLETED later rather than replaced: add the
 * remaining ingredients, clear the flag, and the same row — same id, same menu
 * link, same history — becomes a full recipe.
 *
 * THE COST SHOWN HERE IS NOT A SECOND CALCULATION. Every figure on this screen
 * comes from ingredientLineCost() in src/lib/recipe-cost.ts, which is the exact
 * function recalculateRecipeCost() uses server-side. There is one formula, so
 * the preview and the stored cost cannot disagree.
 *
 * ...provided both sides read the same unit table, which they did not. The server
 * loads `units` from the database at boot; the browser kept the built-in defaults,
 * where PKT is a count of 1 rather than the 1,000 ml his database says. So this
 * screen calls hydrateUnitRegistry() before it prices anything — see the note on
 * that function in src/lib/recipe-cost.ts.
 */

import { useEffect, useMemo, useState } from 'react';
import { X, Plus, Trash2, AlertTriangle, Check, Search, Info } from 'lucide-react';
import MaterialTypeahead, { type MaterialLite } from '@/components/MaterialTypeahead';
import { api } from '@/lib/api';
import { hydrateUnitRegistry, ingredientLineCost, toPaise } from '@/lib/recipe-cost';
import { checkRecipeSanity, type SanityFinding, type SanityInput } from '@/lib/recipe-sanity';
import { suggestMaterials, type SuggestableMaterial } from '@/lib/recipe-suggest';
import { UNIT_REGISTRY } from '@/lib/units';

export interface QuickRecipeMaterial extends MaterialLite {
  average_price?: number | null;
  unit: string;
  pack_size?: number | null;
  category?: string;
  is_active?: number | null;
}

export interface QuickRecipeTarget {
  id: string;
  name: string;
  category?: string | null;
  selling_price?: number | null;
  item_type?: string | null;
}

interface Line {
  key: string;
  material_id: string;
  /** The unit the cook is typing in. Defaults to the MATERIAL's own unit. */
  unit: string;
  /** Kept as a string so the box can be genuinely empty — never a made-up 0.2. */
  qty: string;
}

/**
 * One entry line, shaped for the shared costing formula. Extends SanityInput so
 * it can be handed straight to both ingredientLineCost() and checkRecipeSanity()
 * without a cast — the two functions the server runs on the same data.
 */
interface CostableLine extends SanityInput {
  key: string;
  material_id: string;
  quantity: number;
  unit: string;
  material_unit: string;
  material_name: string;
  material_pack_size: number | null;
  average_price: number;
  yield_percent: number;
  wastage_percent: number;
  /** False while the quantity box is still empty — such a line is not costed. */
  typed: boolean;
}

let seq = 0;
const newKey = () => `l${++seq}`;

const fmt = (n: number) =>
  `₹${toPaise(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Units offered on a line. The material's OWN unit is always first and is the
 * default, because it is the one unit that can never fail to convert — picking
 * anything else is a deliberate act, which is precisely when the sanity check
 * should have something to say.
 */
function unitOptions(materialUnit: string): string[] {
  const own = String(materialUnit || '').toLowerCase().trim();
  // Registry keys are folded to lowercase before comparing. They are not all
  // lowercase — "L" is a key — so an item stocked in litres used to offer "l"
  // (its own unit) AND "L" (the registry key) as two separate choices in one
  // select, which reads as two different units and is the sort of thing that
  // makes a cook stop trusting the list. Deduped case-insensitively, own unit
  // first (it is the one that can never fail to convert).
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of [own, ...Object.keys(UNIT_REGISTRY)]) {
    const key = String(u || '').toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export default function QuickRecipeModal({
  target,
  materials,
  onClose,
  onSaved,
  approximateSupported = true,
}: {
  target: QuickRecipeTarget;
  materials: QuickRecipeMaterial[];
  onClose: () => void;
  /** Called after a successful save so the parent can refresh its list. */
  onSaved: (recipeId: string) => void;
  /**
   * False when this database cannot yet record that a recipe is approximate
   * (served as `approximate_supported` by /api/menu-items). The form is then
   * shown read-only with the reason, instead of saving a rough recipe that would
   * print a rough cost looking exactly like a measured one. Defaults to true so
   * nothing changes for a caller that does not pass it.
   */
  approximateSupported?: boolean;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Bumped once the unit table has been pulled from the server, purely to re-run
   * the memos below — applyRegistryRows mutates a module object, which React
   * cannot see. Without this the first render's prices and unit list would stand
   * until the cook typed something.
   */
  const [unitsLoaded, setUnitsLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    hydrateUnitRegistry().then((ok) => { if (alive && ok) setUnitsLoaded(true); });
    return () => { alive = false; };
  }, []);
  /**
   * ESCAPE CLOSES IT. Cancel, the ✕ and the backdrop all worked; Escape did not,
   * because nothing in this component listened for a key. It is the reflex for
   * getting out of a dialog, and a reflex that does nothing reads as a stuck
   * screen — on a modal whose whole promise is that it never holds anybody up.
   *
   * Bound while `saving` is false only: once the POST is in flight the recipe may
   * already have been written, and closing the screen out from under it would
   * leave the cook unsure whether it saved. Every other way out of this modal is
   * gated the same way.
   */
  useEffect(() => {
    if (saving) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);
  /** Findings signature the cook ticked "save anyway" against. Null = not ticked. */
  const [overrideSig, setOverrideSig] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const byId = useMemo(() => {
    const m = new Map<string, QuickRecipeMaterial>();
    for (const x of materials) m.set(x.id, x);
    return m;
  }, [materials]);

  const price = Number(target.selling_price) || 0;

  // ── SUGGESTIONS. Tick-boxes, nothing pre-ticked, no quantity attached. ─────
  const suggestions = useMemo(
    () => suggestMaterials(target.name, target.category, materials as SuggestableMaterial[], 8),
    [target.name, target.category, materials],
  );

  const chosen = useMemo(() => new Set(lines.map((l) => l.material_id).filter(Boolean)), [lines]);

  /** Add a material with its own unit pre-selected and the quantity EMPTY. */
  const addMaterial = (id: string) => {
    const mat = byId.get(id);
    if (!mat || !id) return;
    setLines((prev) =>
      prev.some((l) => l.material_id === id)
        ? prev
        : [...prev, { key: newKey(), material_id: id, unit: String(mat.unit || '').toLowerCase().trim(), qty: '' }],
    );
  };

  const removeLine = (key: string) => setLines((prev) => prev.filter((l) => l.key !== key));
  const patch = (key: string, p: Partial<Line>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...p } : l)));

  const toggleSuggestion = (id: string) => {
    if (chosen.has(id)) setLines((prev) => prev.filter((l) => l.material_id !== id));
    else addMaterial(id);
  };

  /**
   * Everything the cook has typed, shaped for the shared costing formula.
   * yield_percent 100 / wastage_percent 0 are the COLUMN DEFAULTS — this screen
   * does not ask for them and does not invent them.
   */
  const costable = useMemo(
    () =>
      lines
        .map((l) => {
          const mat = byId.get(l.material_id);
          if (!mat) return null;
          const q = Number(l.qty);
          return {
            key: l.key,
            material_id: l.material_id,
            quantity: Number.isFinite(q) ? q : 0,
            unit: l.unit,
            material_unit: String(mat.unit || ''),
            material_name: mat.name,
            material_pack_size: mat.pack_size ?? null,
            average_price: mat.average_price ?? 0,
            yield_percent: 100,
            wastage_percent: 0,
            typed: l.qty.trim() !== '',
          };
        })
        .filter((c): c is CostableLine => c !== null),
    [lines, byId],
  );

  /** Only lines with a typed quantity are costed or judged. */
  const priced = useMemo(() => costable.filter((c) => c.typed && c.quantity > 0), [costable]);

  // `unitsLoaded` is a dependency, not decoration: checkRecipeSanity costs every
  // line through the unit registry, and the registry changes under it when the
  // server's `units` table arrives. Without this the preview keeps the built-in
  // numbers — the 500×–1000× divergence described in recipe-cost.ts.
  const report = useMemo(() => checkRecipeSanity(priced, price), [priced, price, unitsLoaded]);

  const findingsByIndex = useMemo(() => {
    const m = new Map<string, SanityFinding[]>();
    report.findings.forEach((f) => {
      if (f.index == null) return;
      const key = priced[f.index]?.key;
      if (!key) return;
      m.set(key, [...(m.get(key) || []), f]);
    });
    return m;
  }, [report, priced]);

  const recipeFindings = report.findings.filter((f) => f.index == null);

  const total = report.total_cost;
  const fcPct = price > 0 ? Math.round((total / price) * 10000) / 100 : null;

  /**
   * An acknowledgement is bound to the EXACT findings it was given for.
   *
   * "Save anyway" must not survive the line the cook then edited. Rather than
   * resetting a boolean from an effect (which costs a second render and, worse,
   * lets a save slip through in the frame before it fires), the tick stores the
   * signature of the findings on screen at the moment it was made. Any change to
   * any finding changes the signature, and the override stops matching — it is
   * derived, so there is no window in which it is stale.
   */
  const findingsSig = useMemo(
    () => JSON.stringify(report.findings.map((f) => [f.code, f.index, f.line_cost])),
    [report.findings],
  );
  const override = overrideSig !== null && overrideSig === findingsSig;

  const blocked = report.has_blocker && !override;
  const canSave = priced.length > 0 && !blocked && !saving && approximateSupported;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // THE HOUSE FETCH WRAPPER, not a raw fetch. Every state-changing request in
      // this app carries an X-CSRF-Token header read from the fnb_csrf cookie;
      // api() is the one place that does it. A bare fetch() here compiled, typed
      // and rendered perfectly and then failed every single save with
      // "CSRF token missing or mismatched" — it only shows up when the button is
      // actually pressed against a running server.
      const res = await api('/api/recipes', {
        method: 'POST',
        body: {
          name: target.name,
          category: target.category || '',
          // The recipe's OWN price is left at 0 on purpose. This recipe is being
          // linked to a live menu item, and a linked recipe is costed against the
          // MENU price (src/lib/recipe-price.ts) — writing a copy of that price
          // onto the recipe row would just create a second number to drift.
          selling_price: 0,
          menu_item_id: target.id,
          is_approximate: true,
          ingredients: priced.map((c) => ({
            material_id: c.material_id,
            quantity: c.quantity,
            unit: c.unit,
            yield_percent: 100,
            wastage_percent: 0,
            is_default: 1,
          })),
        },
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j?.error || `Save failed (${res.status})`);
        setSaving(false);
        return;
      }
      onSaved(j?.recipe?.id || '');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Save failed');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div
        style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
        className="relative w-full max-w-3xl bg-white border border-[#E8D5C4] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-[#E8D5C4] shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-[#2D1B0E] truncate">Quick recipe — {target.name}</h2>
            <p className="text-[11px] text-[#8B7355] mt-0.5">
              Tick the expensive ingredients and give a rough quantity for each. No method, no yield, no wastage.
              {price > 0
                ? <> Costed against the <b>{fmt(price)}</b> menu price.</>
                : <> This item has no price yet, so a food cost % cannot be shown.</>}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#FFF1E3] shrink-0"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-5">
          {/* ── The one case where this screen cannot do its job. ─────────── */}
          {!approximateSupported && (
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-red-50 border border-red-300">
              <AlertTriangle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
              <p className="text-[11px] text-red-900 leading-relaxed">
                <b>This recipe cannot be saved right now.</b> The app cannot yet record that a recipe is
                approximate, and saving one without that mark would show a rough cost that looks exactly like a
                measured one. Ask an admin to restart the app, then try again. You can still work out the cost
                below — nothing here is stored until you save.
              </p>
            </div>
          )}

          {/* ── Approximate, said plainly and up front. ───────────────────── */}
          <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-50 border border-amber-200">
            <Info className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
            <p className="text-[11px] text-amber-900 leading-relaxed">
              This saves as an <b>approximate</b> recipe. The cost it produces is real and flows through the normal
              food-cost engine, but it is marked approximate everywhere it appears so nobody prices a dish off it
              believing it is exact. Add the remaining ingredients later and clear the mark — it stays the same recipe.
            </p>
          </div>

          {/* ── SUGGESTIONS — tick-boxes, none pre-ticked. ────────────────── */}
          {suggestions.length > 0 && (
            <div>
              <p className="text-xs font-medium text-[#6B5744] mb-2">
                Likely ingredients for this dish
                <span className="font-normal text-[#8B7355]"> — tick the ones it actually uses. Nothing is selected for you.</span>
              </p>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((s) => {
                  const on = chosen.has(s.material.id);
                  return (
                    <button
                      key={s.material.id}
                      type="button"
                      onClick={() => toggleSuggestion(s.material.id)}
                      title={s.reason}
                      className={`inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1.5 rounded-lg border transition-colors ${
                        on
                          ? 'bg-[#af4408] text-white border-[#af4408]'
                          : 'bg-[#FFF1E3] text-[#3D2614] border-[#D4B896] hover:border-[#af4408]'
                      }`}
                    >
                      <span className={`inline-flex items-center justify-center w-3.5 h-3.5 rounded border ${on ? 'bg-white border-white' : 'border-[#B9A386]'}`}>
                        {on && <Check className="w-3 h-3 text-[#af4408]" />}
                      </span>
                      {s.material.name}
                      <span className={on ? 'text-white/70' : 'text-[#8B7355]'}>
                        ₹{Number(s.material.average_price || 0)}/{String(s.material.unit || '').toLowerCase()}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Any other material. ───────────────────────────────────────── */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-xs font-medium text-[#6B5744]">Ingredients</p>
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="text-[11px] text-[#af4408] hover:underline inline-flex items-center gap-1"
              >
                <Search className="w-3 h-3" /> {showAll ? 'Hide search' : 'Add another material'}
              </button>
            </div>

            {showAll && (
              <div className="mb-3">
                <MaterialTypeahead
                  materials={materials}
                  value=""
                  onPick={(id) => { addMaterial(id); }}
                  excludeIds={[...chosen]}
                  placeholder="Search all materials…"
                />
              </div>
            )}

            {lines.length === 0 ? (
              <div className="text-center py-6 border border-dashed border-[#D4B896] rounded-lg">
                <p className="text-[12px] text-[#8B7355]">
                  Nothing added yet. Tick a suggestion above, or use <b>Add another material</b>.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {lines.map((l) => {
                  const mat = byId.get(l.material_id);
                  if (!mat) return null;
                  const row = costable.find((c) => c.key === l.key)!;
                  const typed = row.typed && row.quantity > 0;
                  const lc = typed ? ingredientLineCost(row) : null;
                  const findings = findingsByIndex.get(l.key) || [];
                  const bad = findings.some((f) => f.severity === 'blocker');

                  return (
                    <div
                      key={l.key}
                      className={`rounded-lg border px-3 py-2.5 ${bad ? 'border-red-300 bg-red-50/60' : 'border-[#E8D5C4] bg-[#FFFBF6]'}`}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[13px] font-medium text-[#2D1B0E] flex-1 min-w-[140px]">{mat.name}</span>

                        <input
                          type="number"
                          inputMode="decimal"
                          step="any"
                          min="0"
                          value={l.qty}
                          onChange={(e) => patch(l.key, { qty: e.target.value })}
                          /* Deliberately blank. A pre-filled quantity would be a
                             number this app invented, and once saved it is
                             indistinguishable from one the cook measured. */
                          placeholder="qty"
                          className="w-24 px-2 py-1.5 bg-white border border-[#D4B896] rounded-lg text-sm text-right"
                        />

                        <select
                          value={l.unit}
                          onChange={(e) => patch(l.key, { unit: e.target.value })}
                          className="px-2 py-1.5 bg-white border border-[#D4B896] rounded-lg text-sm"
                        >
                          {unitOptions(mat.unit).map((u) => (
                            <option key={u} value={u}>{u}</option>
                          ))}
                        </select>

                        <span className="text-[12px] text-[#6B5744] w-24 text-right tabular-nums">
                          {lc ? fmt(lc.line_cost) : <span className="text-[#C4B09A]">—</span>}
                        </span>

                        <button
                          type="button"
                          onClick={() => removeLine(l.key)}
                          className="p-1 rounded-md text-[#8B7355] hover:bg-[#FFF1E3] hover:text-red-600"
                          title="Remove"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* A recipe line is one of the four declared recipe-basis
                          exceptions to the purchase-unit display rule, and it has
                          to be: this text tells the cook which unit to TYPE, the
                          quantity is stored in that unit, and it is costed
                          against average_price, which is ₹ per recipe unit.
                          Leading with the purchase unit would name a unit the
                          entry box does not accept and the costing engine does
                          not use. Nothing is re-derived — mat.unit and
                          mat.average_price are the material's own stored pair.
                          unit-lock: recipe-authoring (ingredient entry line) */}
                      <p className="text-[10px] text-[#8B7355] mt-1">
                        Stocked in <b>{String(mat.unit || '').toLowerCase()}</b> at ₹{Number(mat.average_price || 0)}/{String(mat.unit || '').toLowerCase()}
                        {lc && lc.converted.entered_unit !== lc.converted.in_unit && lc.converted.convertible && (
                          <> · {row.quantity} {lc.converted.entered_unit} = {toPaise(lc.converted.qty)} {lc.converted.in_unit}</>
                        )}
                      </p>

                      {/* ── THE UNIT SANITY CHECK, AT ENTRY. ──────────────── */}
                      {findings.map((f, i) => (
                        <div
                          key={i}
                          className={`mt-2 rounded-md px-2.5 py-2 border ${
                            f.severity === 'blocker'
                              ? 'bg-red-50 border-red-300'
                              : 'bg-amber-50 border-amber-300'
                          }`}
                        >
                          <p className={`text-[11px] font-semibold flex items-start gap-1.5 ${f.severity === 'blocker' ? 'text-red-800' : 'text-amber-900'}`}>
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                            <span>{f.message}</span>
                          </p>
                          <p className={`text-[10px] mt-1 ${f.severity === 'blocker' ? 'text-red-700' : 'text-amber-800'}`}>
                            {f.likely_cause}
                          </p>
                          {/* The unit the money is actually being valued in —
                              spelled out, because "₹63,012" alone tells a cook
                              nothing about which number to change. */}
                          <p className="text-[10px] mt-1 font-mono text-[#6B5744] bg-white/70 rounded px-1.5 py-1">
                            {f.valuing}
                          </p>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── Whole-recipe findings. ────────────────────────────────────── */}
          {recipeFindings.map((f, i) => (
            <div key={i} className="rounded-lg px-3 py-2.5 bg-amber-50 border border-amber-300">
              <p className="text-[11px] font-semibold text-amber-900 flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" /><span>{f.message}</span>
              </p>
              <p className="text-[10px] text-amber-800 mt-1">{f.likely_cause}</p>
            </div>
          ))}
        </div>

        {/* ── Footer: the live total, from the SAME formula that will store it ── */}
        <div className="shrink-0 border-t border-[#E8D5C4] px-6 py-3.5 bg-[#FFFBF6]">
          {error && <p className="text-[12px] text-red-600 mb-2">{error}</p>}

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-[13px] text-[#3D2614]">
              <span className="text-[#8B7355] text-[11px] mr-1.5">Approximate food cost</span>
              <b className="tabular-nums">{fmt(total)}</b>
              {fcPct !== null && (
                <span className={`ml-2 text-[12px] ${fcPct > 100 ? 'text-red-600 font-semibold' : fcPct > 40 ? 'text-amber-700' : 'text-emerald-700'}`}>
                  {fcPct}% of {fmt(price)}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button onClick={onClose} className="px-3 py-2 text-sm text-[#6B5744] hover:bg-[#FFF1E3] rounded-lg">Cancel</button>
              <button
                onClick={save}
                disabled={!canSave}
                className="px-4 py-2 text-sm rounded-lg bg-[#af4408] text-white disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" /> {saving ? 'Saving…' : 'Save approximate recipe'}
              </button>
            </div>
          </div>

          {/* The override. Present, because a cook who genuinely means an odd
              entry must not be stuck — but it costs a deliberate tick, and it
              re-arms the moment anything changes. */}
          {report.has_blocker && (
            <label className="mt-2.5 flex items-start gap-2 text-[11px] text-red-800 cursor-pointer">
              <input
                type="checkbox"
                checked={override}
                onChange={(e) => setOverrideSig(e.target.checked ? findingsSig : null)}
                className="mt-0.5"
              />
              <span>
                I have checked the quantities above and they are correct. Save anyway.
              </span>
            </label>
          )}
          {priced.length === 0 && lines.length > 0 && (
            <p className="mt-2 text-[11px] text-[#8B7355]">Type a quantity for at least one ingredient to save.</p>
          )}
        </div>
      </div>
    </div>
  );
}
