'use client';

/**
 * CRM Call-to-Table — mobile-collapsing toolbar.
 *
 * The filter/tool cluster under each page title is useful on desktop but eats
 * the whole screen on a phone before any data shows. This wraps that cluster:
 *   - phone (< md): collapsed behind a "Filters & options" button (tap to
 *     expand); an optional active-filter count keeps it discoverable when
 *     something IS filtered, and it auto-opens when a filter is active so the
 *     user always sees what's narrowing their results.
 *   - md+ (tablet/desktop): the cluster renders inline as before — the toggle
 *     button is hidden. Zero change to the desktop layout.
 *
 * Purely presentational — the page keeps owning the actual filter state.
 */
import { type ReactNode, useEffect, useState } from 'react';
import { SlidersHorizontal, ChevronDown } from 'lucide-react';

export default function CollapsibleToolbar({
  children,
  activeCount = 0,
  label = 'Filters & options',
}: {
  children: ReactNode;
  /** number of filters currently applied — shown as a badge + forces the panel
   *  open on mobile so an active filter is never hidden. */
  activeCount?: number;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  // Keep the panel open on mobile whenever a filter is active, so results are
  // never silently narrowed by a hidden control.
  useEffect(() => { if (activeCount > 0) setOpen(true); }, [activeCount]);

  return (
    <div>
      {/* Mobile toggle — hidden on md+ */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls="ct-toolbar-panel"
        className="md:hidden w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-[#E8D5C4] text-sm font-medium text-[#6B5744] shadow-sm"
      >
        <SlidersHorizontal className="w-4 h-4 text-[#af4408]" />
        <span>{label}</span>
        {activeCount > 0 && (
          <span className="ml-1 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-[#af4408] text-white text-[11px] font-bold">
            {activeCount}
          </span>
        )}
        <ChevronDown className={`w-4 h-4 ml-auto text-[#8B7355] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* The actual controls: always shown on md+, toggled on mobile. */}
      <div id="ct-toolbar-panel" className={`${open ? 'block' : 'hidden'} md:block mt-2 md:mt-0`}>
        {children}
      </div>
    </div>
  );
}
