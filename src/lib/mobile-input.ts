/**
 * Single source of truth for "an Indian mobile is 10 digits".
 *
 * capMobile10 caps a free-typed / pasted value to a valid 10-digit Indian
 * mobile: keep digits only, drop a leading 91 (country code) or 0 (trunk
 * prefix), then keep the LAST 10 digits. Used on every mobile/phone <input>
 * (onChange) so the field can never hold more than 10 digits, and on the
 * server so the same rule holds even if a client is bypassed.
 *
 *   capMobile10('98765 43210')      → '9876543210'
 *   capMobile10('+91-9876543210')   → '9876543210'
 *   capMobile10('09876543210')      → '9876543210'
 *   capMobile10('98765432109999')   → '9876543210'  (extra digits dropped)
 */
export function capMobile10(raw: unknown): string {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length > 10) d = d.slice(-10);
  return d;
}

/** True only for a well-formed Indian mobile (10 digits, starts 6–9). */
export function isValidMobile10(raw: unknown): boolean {
  return /^[6-9]\d{9}$/.test(capMobile10(raw));
}
