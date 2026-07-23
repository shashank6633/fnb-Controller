/**
 * Country dial codes for the mobile/phone picker. India first (default).
 * Curated to the countries an Indian F&B venue realistically sees — extend
 * freely; the picker and parsing work for any entry here.
 *
 * `nsn` = expected National Significant Number length (digits AFTER the dial
 * code). Used to cap the national input per country. Null = variable/unknown →
 * fall back to a generic E.164 cap.
 */
export interface CountryCode {
  code: string;   // dial code WITHOUT '+', e.g. '91'
  iso: string;    // ISO-3166 alpha-2, e.g. 'IN'
  name: string;
  nsn: number | null;   // national number length (null = variable)
}

export const COUNTRY_CODES: CountryCode[] = [
  { code: '91',  iso: 'IN', name: 'India',            nsn: 10 },
  { code: '971', iso: 'AE', name: 'UAE',              nsn: 9 },
  { code: '966', iso: 'SA', name: 'Saudi Arabia',     nsn: 9 },
  { code: '974', iso: 'QA', name: 'Qatar',            nsn: 8 },
  { code: '968', iso: 'OM', name: 'Oman',             nsn: 8 },
  { code: '965', iso: 'KW', name: 'Kuwait',           nsn: 8 },
  { code: '973', iso: 'BH', name: 'Bahrain',          nsn: 8 },
  { code: '1',   iso: 'US', name: 'USA / Canada',     nsn: 10 },
  { code: '44',  iso: 'GB', name: 'UK',               nsn: 10 },
  { code: '65',  iso: 'SG', name: 'Singapore',        nsn: 8 },
  { code: '60',  iso: 'MY', name: 'Malaysia',         nsn: null },
  { code: '61',  iso: 'AU', name: 'Australia',        nsn: 9 },
  { code: '94',  iso: 'LK', name: 'Sri Lanka',        nsn: 9 },
  { code: '977', iso: 'NP', name: 'Nepal',            nsn: 10 },
  { code: '880', iso: 'BD', name: 'Bangladesh',       nsn: 10 },
  { code: '49',  iso: 'DE', name: 'Germany',          nsn: null },
  { code: '33',  iso: 'FR', name: 'France',           nsn: 9 },
  { code: '81',  iso: 'JP', name: 'Japan',            nsn: null },
  { code: '86',  iso: 'CN', name: 'China',            nsn: 11 },
  { code: '7',   iso: 'RU', name: 'Russia',           nsn: 10 },
];

export const DEFAULT_DIAL_CODE = '91';

/** E.164 caps a full number at 15 digits INCLUDING the dial code. */
export const E164_MAX_DIGITS = 15;

const BY_CODE = new Map(COUNTRY_CODES.map((c) => [c.code, c]));

/** Look up a dial code (without '+'). Longest-prefix match is handled by
 *  splitE164 — this is an exact-code lookup. */
export function countryByDialCode(code: string): CountryCode | undefined {
  return BY_CODE.get(String(code || '').replace(/\D/g, ''));
}

/** Flag emoji for an ISO-3166 alpha-2 code (e.g. 'IN' → 🇮🇳), via regional
 *  indicator symbols. Renders as a flag on iOS/Android/macOS; on Windows it
 *  degrades to the two letters — still readable. '' for a bad code. */
export function flagEmoji(iso: string): string {
  const cc = String(iso || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(cc.charCodeAt(0) + 127397, cc.charCodeAt(1) + 127397);
}

/** Max national digits allowed for a dial code (its NSN, else fits E.164). */
export function maxNationalDigits(dialCode: string): number {
  const c = countryByDialCode(dialCode);
  if (c?.nsn) return c.nsn;
  return Math.max(4, E164_MAX_DIGITS - String(dialCode || '').replace(/\D/g, '').length);
}
