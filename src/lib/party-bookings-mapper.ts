/**
 * Party Bookings sheet (separate tab from F&P Records, same Google Sheet).
 * We use this only to fetch the booking revenue for each party so we can
 * compute per-party P&L. Linked to F&P Records via party_unique_id.
 *
 * Layout (from user):
 *   Column A (index 0)  → Party Unique ID  ← link key
 *   Column U (index 20) → Final Total Amount  ← revenue
 *
 * Everything else in the tab is ignored for now.
 */

export interface PartyBooking {
  party_unique_id: string;
  final_total: number;
}

function toNumber(v: any): number {
  if (v == null || v === '' || v === '-') return 0;
  const cleaned = String(v).replace(/[Rr]s\.?/g, '').replace(/[,\s₹]/g, '').trim();
  if (!cleaned) return 0;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export const PARTY_BOOKINGS_COLS = {
  party_unique_id: 0,
  final_total: 20,   // col U
} as const;

export function mapRowToPartyBooking(row: string[]): PartyBooking | null {
  const id = String(row[PARTY_BOOKINGS_COLS.party_unique_id] || '').trim();
  if (!id) return null;
  return {
    party_unique_id: id,
    final_total: toNumber(row[PARTY_BOOKINGS_COLS.final_total]),
  };
}
