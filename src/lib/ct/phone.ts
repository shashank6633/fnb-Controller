/**
 * Phone normalization for the Call-to-Table CRM.
 *
 * E.164 (+91XXXXXXXXXX for India) is the JOIN KEY of the whole module —
 * ct_guests.phone_e164 ↔ ct_calls.phone_e164 ↔ ct_recoveries.phone_e164.
 * Normalize at EVERY ingestion point (webhooks, manual guest create, seed,
 * backfill) so one canonical format exists everywhere.
 */

/** Best-effort E.164. Indian 10-digit numbers get +91; already-prefixed
 *  international numbers keep their country code. Returns '' when the input
 *  has fewer than 8 digits (not a dialable number — never join on it). */
export function normalizePhone(raw: unknown): string {
  if (raw == null) return '';
  let s = String(raw).trim();
  if (!s) return '';
  // Strip everything except digits and a leading +
  const hadPlus = s.startsWith('+');
  s = s.replace(/[^\d]/g, '');
  if (!s) return '';
  // Strip common Indian trunk prefixes: 0XXXXXXXXXX
  if (!hadPlus && s.length === 11 && s.startsWith('0')) s = s.slice(1);
  // 91XXXXXXXXXX without + (12 digits starting 91, mobile 6-9 next)
  if (!hadPlus && s.length === 12 && s.startsWith('91') && /[6-9]/.test(s[2])) {
    return `+${s}`;
  }
  if (hadPlus) {
    return s.length >= 8 ? `+${s}` : '';
  }
  // Bare 10-digit Indian mobile/landline-with-STD
  if (s.length === 10) return `+91${s}`;
  return s.length >= 8 ? `+${s}` : '';
}

/** Display helper: +919876543210 → "98765 43210" (Indian grouping), other
 *  countries returned as-is. */
export function formatPhone(e164: string): string {
  if (!e164) return '';
  if (/^\+91\d{10}$/.test(e164)) {
    const n = e164.slice(3);
    return `${n.slice(0, 5)} ${n.slice(5)}`;
  }
  return e164;
}
