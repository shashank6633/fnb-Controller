/**
 * Single source of truth for "an Indian mobile is 10 digits".
 *
 * capMobile10 caps a free-typed / pasted value to at most 10 digits:
 *   1. keep digits only,
 *   2. treat a leading +91 / 91 country code or a trunk 0 as a PREFIX (not part
 *      of the number) and strip it,
 *   3. keep the FIRST 10 of what remains.
 *
 * The field therefore can never hold more than 10 digits. We keep the FIRST 10
 * (never the last 10): a longer entry is a typo with EXTRA digits on the end, so
 * dropping the tail preserves the number the user actually meant — the last-10
 * rule would have stored a completely different number.
 *
 *   capMobile10('98765 43210')       → '9876543210'
 *   capMobile10('+91-9876543210')    → '9876543210'   (country code stripped)
 *   capMobile10('09876543210')       → '9876543210'   (trunk 0 stripped)
 *   capMobile10('987654321099999')   → '9876543210'   (extra tail digits dropped)
 */
export function capMobile10(raw: unknown): string {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('91')) d = d.slice(2);   // +91 / 91 country code
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1); // trunk 0
  return d.slice(0, 10);   // hard cap — first 10, never reinterpret by the tail
}

/** True only for a well-formed Indian mobile (exactly 10 digits, starts 6–9). */
export function isValidMobile10(raw: unknown): boolean {
  return /^[6-9]\d{9}$/.test(capMobile10(raw));
}

/**
 * Did the raw input carry MORE digits than a valid 10-digit mobile (after
 * stripping a +91/0 prefix)? Lets a form show "can't exceed 10 digits" instead
 * of silently accepting a truncated value. A clean 10-digit number, or a
 * properly-prefixed +91/0 number, returns false.
 */
export function mobileHasExtraDigits(raw: unknown): boolean {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d.length > 10;
}

// ── Multi-country phone (country-code picker) ──────────────────────────────
// Storage contract (backward compatible): a +91 number is stored as its BARE
// national digits (exactly as before this feature), so every existing +91 flow
// is unchanged. Any OTHER country is stored as full E.164 ('+<cc><national>').
// A stored value is therefore self-describing: leading '+' → parse the country
// from it; bare digits → India (+91).
import { COUNTRY_CODES, DEFAULT_DIAL_CODE, maxNationalDigits } from '@/lib/country-codes';

// Longest dial code first so '+9715…' matches '971' before '91'/'1'.
const DIAL_CODES_LONGEST_FIRST = [...COUNTRY_CODES]
  .map((c) => c.code)
  .sort((a, b) => b.length - a.length);

/** Cap national-number input for a given dial code: digits only, capped to that
 *  country's national length (India → 10). */
export function capNational(dialCode: string, raw: unknown): string {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.slice(0, maxNationalDigits(dialCode));
}

/** Parse a stored phone value into { dialCode, national }.
 *  '9876543210'      → { '91', '9876543210' }   (bare = India, unchanged legacy)
 *  '+919876543210'   → { '91', '9876543210' }
 *  '+9715XXXXXXXX'   → { '971', '5XXXXXXXX' }
 *  '09876543210'     → { '91', '9876543210' }   (trunk 0 dropped) */
export function parseStoredPhone(value: unknown): { dialCode: string; national: string } {
  const raw = String(value ?? '').trim();
  const hadPlus = raw.startsWith('+') || raw.replace(/\D/g, '').length > 11;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return { dialCode: DEFAULT_DIAL_CODE, national: '' };
  if (hadPlus) {
    for (const cc of DIAL_CODES_LONGEST_FIRST) {
      if (digits.startsWith(cc) && digits.length > cc.length) {
        return { dialCode: cc, national: capNational(cc, digits.slice(cc.length)) };
      }
    }
    // Unknown code but international-looking → keep as India fallback on the last 10.
  }
  // Bare digits → India. Drop a trunk 0, keep the 10-digit core.
  let d = digits;
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return { dialCode: DEFAULT_DIAL_CODE, national: capNational(DEFAULT_DIAL_CODE, d) };
}

/** Combine a picker's { dialCode, national } into the stored value.
 *  India → BARE national (backward-compatible); others → '+<cc><national>'.
 *  Empty national → '' (so an untouched field stays empty, not '+91'). */
export function toStoredPhone(dialCode: string, national: string): string {
  const nat = String(national ?? '').replace(/\D/g, '');
  if (!nat) return '';
  const cc = String(dialCode || DEFAULT_DIAL_CODE).replace(/\D/g, '');
  return cc === DEFAULT_DIAL_CODE ? nat : `+${cc}${nat}`;
}

/** Valid stored phone? India → exactly a 10-digit [6-9] mobile; any other
 *  country → E.164 with 8–15 total digits. Empty is NOT valid (callers decide
 *  whether the field is optional). */
export function isValidPhone(value: unknown): boolean {
  const { dialCode, national } = parseStoredPhone(value);
  if (!national) return false;
  if (dialCode === '91') return /^[6-9]\d{9}$/.test(national);
  const total = dialCode.length + national.length;
  return national.length >= 4 && total >= 8 && total <= 15;
}

/** Display a stored phone for humans: '+91 98765 43210', '+971 5XXXXXXXX'. */
export function formatStoredPhone(value: unknown): string {
  const { dialCode, national } = parseStoredPhone(value);
  if (!national) return '';
  if (dialCode === '91' && national.length === 10) {
    return `+91 ${national.slice(0, 5)} ${national.slice(5)}`;
  }
  return `+${dialCode} ${national}`;
}
