/**
 * A CARD'S FIGURE THAT ALWAYS FITS ITS CARD (owner ruling 115 (d), 2026-11-05).
 *
 * The owner saw "₹44,21,404.73" spill past the Subtotal card and
 * "₹45,74,951.78" past the Grand Total card when eight cards shared one row. A
 * fixed text-xl cannot be right at every width: the same card is ~110px wide on
 * a phone and ~300px on a desktop, and the figure grows from "₹0.00" to
 * "₹1,36,00,000.00" with the books.
 *
 * So the figure is sized off ITS OWN CARD. The card is a size container
 * (Tailwind's `@container`, i.e. container-type: inline-size) and the figure's
 * font-size is a share of the card's width (cqi), chosen from the figure's own
 * length so the whole string fits: a glyph of Inter Bold with tabular figures
 * is at most ~0.66em wide (digits, ₹ and the minus; commas and the point are
 * narrower), so `len × 0.66 × size ≤ card width` holds by construction. Capped
 * at `maxRem` (the old text-xl, so a short figure looks exactly as before) and
 * floored at `minRem` (11px) so it stays readable. The floor CAN decide: on a
 * 320px phone a two-to-a-row card holding a crore figure sits at it. There the
 * figure is no longer sized off its card, and it stays inside only because
 * 0.66em is the widest glyph and the commas and the point are narrower —
 * measured 2026-11-07, All time at 320px: "₹1,15,09,145.38" at 11px is 90px of
 * text in a 100px card.
 *
 * CLIENT-SAFE. No imports. Returns a style object for the figure element; the
 * figure element must also be `whitespace-nowrap` (never wrap, never ellipsis)
 * and its card must carry `@container`.
 */
export function fitFigureStyle(value: string, maxRem = 1.25, minRem = 0.6875): { fontSize: string } {
  const len = Math.max(4, Array.from(String(value ?? '')).length);
  const cqi = (100 / (len * 0.66)).toFixed(2);
  return { fontSize: `clamp(${minRem}rem, ${cqi}cqi, ${maxRem}rem)` };
}
