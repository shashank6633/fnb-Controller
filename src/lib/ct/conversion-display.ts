/**
 * Shared conversion formatting — the ONE renderer every surface uses.
 * Kept free of imports so client components and server routes can both use it
 * (importing metrics.ts from a client component would pull better-sqlite3 into
 * the browser bundle — never do that).
 */

/** Printed wherever a guest has no bookings. 0/0 is not 0%. */
export const NO_CONVERSION = '—';
/** Sub-label under an em-dash conversion tile. */
export const NO_CONVERSION_SUB = 'No bookings yet';
/** Tooltip/help text for the guest conversion, used verbatim on every surface. */
export const CONVERSION_HELP =
  'Bookings that reached the table (seated or completed) ÷ all their bookings. Cancelled, no-show and upcoming bookings count in the total.';

/** 0.75 → "75%".  null/undefined → "—".  Integer percent, no decimals. */
export function fmtConversion(rate: number | null | undefined): string {
  return rate == null ? NO_CONVERSION : `${Math.round(rate * 100)}%`;
}

/** CSV cell: 0.75 → 75.  null/undefined → '' (never 0). Header says "%". */
export function csvConversion(rate: number | null | undefined): number | '' {
  return rate == null ? '' : Math.round(rate * 100);
}
