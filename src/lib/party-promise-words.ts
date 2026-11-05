import { packFactor, shownPurchaseQty, fmtQtyNum, type PackMeta } from '@/lib/pack-units';

/**
 * THE WORDS FOR PARTY STOCK ALREADY ISSUED ELSEWHERE — ONE COPY (owner ruling
 * #86a, round 3 re-check, 2026-10-29).
 *
 * Three places print the same facts about one row: the store's 409
 * 'party_promised' sentence (src/lib/party-pending.ts), the store desk's In
 * store cell, its hover and its pre-check note (store-requisitions/page.tsx),
 * and the /requisitions Process window (requisitions/page.tsx). Each had its
 * own copy of the wording, and they drifted: with 0.01 pcs (= 0.0002 CASE) of
 * BISLARI left unclaimed, the cell said "free 0 CASE", its hover "none of it
 * is free", and the pre-check and the store "less than 0.001 CASE of it is
 * free". Every one of them now prints through this module.
 *
 * PURE: no database, no server-only import (pack-units.ts only), so the
 * client pages import it as they import pack-units.
 *
 * DISPLAY ONLY. Nothing here decides anything: THE RULE (central-debit-clamp),
 * desk-rule.ts, planCentralDebit, party-fulfillment.ts and every server
 * decision are untouched; only how a figure that is already decided is said.
 */

/** 6-dp grid point, as an integer (central-debit-clamp.ts qtyGrid / desk-rule.ts deskGrid). */
const grid6 = (n: number): number => {
  const v = Math.round((Number(n) || 0) * 1e6);
  return v === 0 ? 0 : v;
};

/** The material's PURCHASE unit (party-pending.ts purchaseUnitOf). */
export function promisePU(meta: PackMeta): string {
  return String((meta.purchase_unit && String(meta.purchase_unit).trim()) || meta.unit || '').trim();
}

/** A PURCHASE figure ALREADY at display precision (3 dp), with its unit. */
export function promiseFigPU(shown: number, meta: PackMeta): string {
  const pu = promisePU(meta);
  return `${fmtQtyNum(shown)}${pu ? ` ${pu}` : ''}`;
}

/** A RECIPE quantity as the storekeeper reads it: PURCHASE unit first, at the
 *  "In store" column's own precision (pack-units.ts shownPurchaseQty). */
export function promiseFig(recipe: number, meta: PackMeta): string {
  return promiseFigPU(shownPurchaseQty(recipe, meta), meta);
}

/** "is" / "are" (and "has" / "have") for a figure as printed. */
export const isAreShown = (shown: number): string => (shown === 1 ? 'is' : 'are');
export const hasHaveShown = (shown: number): string => (shown === 1 ? 'has' : 'have');
export const promiseIsAre = (recipe: number, meta: PackMeta): string => isAreShown(shownPurchaseQty(recipe, meta));
export const promiseHasHave = (recipe: number, meta: PackMeta): string => hasHaveShown(shownPurchaseQty(recipe, meta));

/**
 * WHAT IS FREE, READ AT THE COLUMN'S OWN PRECISION.
 *   'free'  — a positive figure that prints (shown > 0)
 *   'crumb' — positive on the 6-dp grid, but below one printed step: it prints
 *             as 0, so it is said as "less than 0.001 <unit>", never "none"
 *             (the books DO hold it) and never "0" alone
 *   'short' — negative, and the shortfall prints (shown = how much)
 *   'none'  — exactly nothing, or a negative crumb (nothing is free)
 */
export type FreeKind = 'free' | 'crumb' | 'short' | 'none';
export function readFree(freeRecipe: number, meta: PackMeta): { kind: FreeKind; shown: number } {
  const up = shownPurchaseQty(freeRecipe, meta);
  if (up > 0) return { kind: 'free', shown: up };
  if (grid6(freeRecipe) > 0) return { kind: 'crumb', shown: 0 };
  const down = shownPurchaseQty(-(Number(freeRecipe) || 0), meta);
  if (down > 0) return { kind: 'short', shown: down };
  return { kind: 'none', shown: 0 };
}

/** "less than 0.001 CASE" — one printed step of the purchase unit. */
export function crumbFig(meta: PackMeta): string {
  const pu = promisePU(meta);
  return `less than 0.001${pu ? ` ${pu}` : ''}`;
}

/** The server's "nothing printable is free" words (was party-pending.ts
 *  noneFreeWords): "less than 0.001 CASE of it is free" over a positive crumb,
 *  else "none of it is free". */
export function noneFreeWords(freeRecipe: number, meta: PackMeta): string {
  return grid6(freeRecipe) > 0 ? `${crumbFig(meta)} of it is free` : 'none of it is free';
}

/**
 * The free figure inside a sentence:
 *   "7.917 CASE is free" ("only 7.917 CASE is free" with `only`)
 *   "less than 0.001 CASE of it is free"
 *   "none of it is free"
 * and, for a printed shortfall, `short(figure)` when the caller has words for
 * it (else "none of it is free" — nothing is free).
 */
export function freeIsWords(
  freeRecipe: number, meta: PackMeta,
  opts: { only?: boolean; short?: (fig: string) => string } = {},
): string {
  const r = readFree(freeRecipe, meta);
  if (r.kind === 'free') return `${opts.only ? 'only ' : ''}${promiseFigPU(r.shown, meta)} is free`;
  if (r.kind === 'short' && opts.short) return opts.short(promiseFigPU(r.shown, meta));
  return noneFreeWords(freeRecipe, meta);
}

/** The In store cell's free line: "free 7.917 CASE" | "free less than 0.001
 *  CASE" | "short 1 pcs" | "free 0 CASE". */
export function freeCellWords(freeRecipe: number, meta: PackMeta): string {
  const r = readFree(freeRecipe, meta);
  if (r.kind === 'free') return `free ${promiseFigPU(r.shown, meta)}`;
  if (r.kind === 'crumb') return `free ${crumbFig(meta)}`;
  if (r.kind === 'short') return `short ${promiseFigPU(r.shown, meta)}`;
  return `free ${promiseFigPU(0, meta)}`;
}

/**
 * ROUNDED PARTS THAT ADD UP TO THE ROUNDED TOTAL (largest remainder).
 *
 * Each part rounded on its own can miss the total rounded on its own by a
 * step: BISLARI 10 CASE (480 pcs) held 100 pcs + 379.99 pcs printed "10 CASE
 * promised — 2.083 to REQ-A, 7.916 to REQ-B", which sums to 9.999. Here the
 * total is the parts' sum rounded once (shownPurchaseQty of it), and the
 * steps it needs are handed out by largest remainder: 2.083 + 7.917.
 *
 *   · Each part starts at its own rounding (shownPurchaseQty — what it prints
 *     alone), so where the parts already add up NOTHING changes.
 *   · A missing step goes to the part rounded DOWN the most; a step too many
 *     comes off the part rounded UP the most. Ties: `key` ascending (callers
 *     pass the requisition id, which every surface knows) — deterministic, so
 *     the server and the pages hand the same step to the same requisition.
 *   · A part that prints is never taken down to 0. When the total cannot be
 *     met under that rule, every part keeps its own rounding and the total is
 *     printed as their SUM — the parts and the total still agree.
 *
 * Returns each part's printed figure (PURCHASE units, 3 dp), aligned with
 * `parts`, and the total to print beside them (= their sum).
 */
export function apportionShown(
  parts: Array<{ key: string; recipe: number }>, meta: PackMeta,
): { shown: number[]; total: number } {
  const pf = packFactor(meta) || 1;
  const g = parts.map(p => Math.max(0, grid6(p.recipe)));
  const x = g.map(v => v / (pf * 1000));                       // exact, in printed steps
  const own = x.map(v => Math.round(v));                       // = shownPurchaseQty × 1000
  const target = Math.round(g.reduce((s, v) => s + v, 0) / (pf * 1000));
  const out = own.slice();
  let d = target - own.reduce((s, v) => s + v, 0);
  if (d !== 0) {
    const idx = parts.map((_, i) => i);
    const byKey = (a: number, b: number) => String(parts[a].key).localeCompare(String(parts[b].key));
    const cand = d > 0
      ? idx.filter(i => x[i] - own[i] > 1e-9)
          .sort((a, b) => ((x[b] - own[b]) - (x[a] - own[a])) || byKey(a, b))
      : idx.filter(i => own[i] - x[i] > 1e-9 && own[i] >= 2)
          .sort((a, b) => ((own[b] - x[b]) - (own[a] - x[a])) || byKey(a, b));
    if (cand.length >= Math.abs(d)) {
      for (let k = 0; k < Math.abs(d); k++) out[cand[k]] += d > 0 ? 1 : -1;
      d = 0;
    }
    // else: every part keeps its own rounding; the total is their sum (below).
  }
  const steps = out.reduce((s, v) => s + v, 0);
  const norm = (v: number) => { const r = v / 1000; return r === 0 ? 0 : r; };
  return { shown: out.map(norm), total: norm(steps) };
}
