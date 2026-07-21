'use client';

import { Check } from 'lucide-react';

/**
 * The app's standard on/off switch — one consistent, accessible toggle used
 * everywhere (settings, feature flags, etc.). Cream/brown theme:
 *   OFF → a defined neutral track (bordered so it doesn't wash out on cream)
 *   ON  → accent #af4408 track + a white knob carrying a small check
 * Keyboard + screen-reader friendly (role="switch", Enter/Space via <button>),
 * with a focus-visible ring and a smooth spring on the knob.
 */
export default function Toggle({
  checked,
  onChange,
  disabled = false,
  size = 'md',
  label,
  title,
  id,
  className = '',
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
  label?: string;
  title?: string;
  id?: string;
  className?: string;
}) {
  const d =
    size === 'sm'
      ? { track: 'h-5 w-9', knob: 'h-4 w-4', on: 'translate-x-[18px]', off: 'translate-x-[2px]', icon: 8 }
      : { track: 'h-6 w-11', knob: 'h-5 w-5', on: 'translate-x-[22px]', off: 'translate-x-[2px]', icon: 11 };

  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      title={title || label}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={[
        'relative inline-flex shrink-0 items-center rounded-full border transition-colors duration-200 ease-out',
        'outline-none focus-visible:ring-2 focus-visible:ring-[#af4408]/40 focus-visible:ring-offset-1',
        d.track,
        checked ? 'bg-[#af4408] border-[#903905]' : 'bg-[#EFE1D0] border-[#D8C3A8]',
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
        className,
      ].join(' ')}
    >
      <span
        className={[
          'pointer-events-none inline-flex items-center justify-center rounded-full bg-white transform transition-transform duration-200 ease-out',
          'shadow-[0_1px_2px_rgba(45,27,14,0.35)]',
          d.knob,
          checked ? d.on : d.off,
        ].join(' ')}
      >
        <Check
          size={d.icon}
          strokeWidth={3.5}
          className={`text-[#af4408] transition-opacity duration-150 ${checked ? 'opacity-100' : 'opacity-0'}`}
        />
      </span>
    </button>
  );
}
