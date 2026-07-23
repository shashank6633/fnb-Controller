'use client';

/**
 * PhoneField — a country-code selector + national-number input that emits a
 * single stored phone string via onChange.
 *
 * Storage contract (see src/lib/mobile-input.ts):
 *   • +91 (default) → BARE national digits ('9876543210') — unchanged legacy
 *     behaviour, so every existing India flow, match, OTP and WhatsApp is
 *     untouched.
 *   • any other country → full E.164 ('+9715XXXXXXXX').
 * The stored value is self-describing, so passing it back as `value` restores
 * the right country automatically.
 *
 * Drop-in for a bare 10-digit <input>: keep your existing string state, just
 *   <PhoneField value={mobile} onChange={setMobile} />
 * National input is capped per country (India → 10 digits).
 */
import { useMemo } from 'react';
import { COUNTRY_CODES, flagEmoji } from '@/lib/country-codes';
import { parseStoredPhone, capNational, toStoredPhone } from '@/lib/mobile-input';

export default function PhoneField({
  value,
  onChange,
  disabled,
  placeholder = 'Mobile number',
  className = '',
  inputClassName = '',
  selectClassName = '',
  autoFocus,
  id,
  ariaLabel,
}: {
  value: string;
  onChange: (stored: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;          // wrapper
  inputClassName?: string;     // national input (defaults to a neutral style)
  selectClassName?: string;    // country <select>
  autoFocus?: boolean;
  id?: string;
  ariaLabel?: string;
}) {
  const { dialCode, national } = useMemo(() => parseStoredPhone(value), [value]);

  const baseInput =
    'flex-1 min-w-0 px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]';
  const baseSelect =
    'shrink-0 px-2 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]';

  return (
    <div className={`flex gap-1.5 ${className}`}>
      <select
        aria-label="Country code"
        disabled={disabled}
        className={selectClassName || baseSelect}
        value={dialCode}
        onChange={(e) => onChange(toStoredPhone(e.target.value, capNational(e.target.value, national)))}
      >
        {COUNTRY_CODES.map((c) => (
          <option key={c.iso} value={c.code}>{flagEmoji(c.iso)} +{c.code} {c.iso}</option>
        ))}
      </select>
      <input
        id={id}
        aria-label={ariaLabel || placeholder}
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder={placeholder}
        className={inputClassName || baseInput}
        value={national}
        onChange={(e) => onChange(toStoredPhone(dialCode, capNational(dialCode, e.target.value)))}
      />
    </div>
  );
}
