/**
 * Party Bookings sheet (separate tab from F&P Records, same Google Sheet).
 *
 * This is the FULL booking pipeline — every enquiry / confirmed / tentative
 * party, not just the ones prepared into F&P Records. The GRE "What's On" board
 * reads it (via the `party_bookings_cache`) so a GRE sees every party on a date
 * with its status, host, company, place and who's handling it. The Party P&L
 * flow uses only party_unique_id + final_total for revenue matching.
 *
 * Column layout (from the sheet, left→right):
 *   A(0) Unique ID · B(1) Date · C(2) Host Name · D(3) Phone Number ·
 *   E(4) Company · F(5) Place · G(6) Handled By · H(7) Occasion Type ·
 *   I(8) Party Time · J(9) Expected Pax · K(10) Package Selected ·
 *   L(11) Special Requirements · M(12) Status · … · U(20) Final Total Amount
 */
import { toIsoDate } from './fp-records-mapper';

export interface PartyBooking {
  party_unique_id: string;
  date: string;                 // YYYY-MM-DD ('' if unparseable)
  host_name: string;
  phone: string;
  company: string;
  place: string;
  handled_by: string;
  occasion: string;
  party_time: string;
  expected_pax: number;
  package: string;
  special_requirements: string;
  status: string;
  final_total: number;
}

function toNumber(v: any): number {
  if (v == null || v === '' || v === '-') return 0;
  const cleaned = String(v).replace(/[Rr]s\.?/g, '').replace(/[,\s₹]/g, '').trim();
  if (!cleaned) return 0;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

const str = (v: any): string => (v == null ? '' : String(v).trim());

export const PARTY_BOOKINGS_COLS = {
  party_unique_id: 0,      // A
  date: 1,                 // B
  host_name: 2,            // C
  phone: 3,                // D
  company: 4,              // E
  place: 5,                // F
  handled_by: 6,           // G
  occasion: 7,             // H
  party_time: 8,           // I
  expected_pax: 9,         // J
  package: 10,             // K
  special_requirements: 11,// L
  status: 12,              // M
  final_total: 20,         // U
} as const;

export function mapRowToPartyBooking(row: string[]): PartyBooking | null {
  const id = str(row[PARTY_BOOKINGS_COLS.party_unique_id]);
  const host = str(row[PARTY_BOOKINGS_COLS.host_name]);
  // Keep a row if it has EITHER a unique id or a host name (some enquiries may
  // not have an id assigned yet) — otherwise it's a blank spacer row.
  if (!id && !host) return null;
  return {
    party_unique_id: id,
    date: toIsoDate(row[PARTY_BOOKINGS_COLS.date]) || '',
    host_name: host,
    phone: str(row[PARTY_BOOKINGS_COLS.phone]),
    company: str(row[PARTY_BOOKINGS_COLS.company]),
    place: str(row[PARTY_BOOKINGS_COLS.place]),
    handled_by: str(row[PARTY_BOOKINGS_COLS.handled_by]),
    occasion: str(row[PARTY_BOOKINGS_COLS.occasion]),
    party_time: str(row[PARTY_BOOKINGS_COLS.party_time]),
    expected_pax: toNumber(row[PARTY_BOOKINGS_COLS.expected_pax]),
    package: str(row[PARTY_BOOKINGS_COLS.package]),
    special_requirements: str(row[PARTY_BOOKINGS_COLS.special_requirements]),
    status: str(row[PARTY_BOOKINGS_COLS.status]),
    final_total: toNumber(row[PARTY_BOOKINGS_COLS.final_total]),
  };
}
