'use client';

/**
 * THE quantity renderer for purchase-unit surfaces (owner rule 2026-07-27:
 * Inventory / Store / Purchase / Requisitions / Issuing / Dept-Stock read in
 * PURCHASE units; recipes and exact-balance reports stay recipe).
 *
 * Prop IS the DualQty wire type, so a server payload (store-issued-log shape)
 * drops in unchanged; a client-side surface builds one with dualQty(row.qty, row).
 * The recipe figure renders as a small hint underneath only when the material
 * actually converts — it is the number the money and stock deductions use, so
 * it must stay visible on demand, never silently dropped.
 *
 * DO NOT import this from a recipe/food-consumption surface — that boundary is
 * the whole point of having one component.
 */

import { displayQty, type DualQty, type HintStyle, type PackMeta } from '@/lib/pack-units';

export default function Qty({ d, hint = 'recipe', meta, strong, className }: {
  d: DualQty;
  hint?: HintStyle;
  /** Needed only for hint="breakdown" (cases + bottles + loose). */
  meta?: PackMeta;
  strong?: boolean;
  className?: string;
}) {
  const q = displayQty(d, { hint, meta });
  return (
    <span className={className}>
      <span className={strong ? 'font-semibold' : undefined}>{q.primary}</span>
      {q.hint && (
        <span className="block text-[9px] font-normal text-[#B8A590]">{q.hint}</span>
      )}
    </span>
  );
}
