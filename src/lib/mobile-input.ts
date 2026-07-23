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
