/**
 * TabScroller — horizontal one-row scroller for tab / filter-pill strips.
 *
 * On phones a long row of status tabs or category chips used to wrap into 2-3
 * messy rows (or overflow). This container keeps them on ONE row that scrolls
 * sideways (scrollbar hidden), and restores the classic wrapping layout on
 * md+ so desktop looks unchanged.
 *
 * Notes:
 *  - `flex-nowrap` is load-bearing: globals.css §9 force-wraps any
 *    `.flex.gap-2/3/4` inside <main> on phones unless `.flex-nowrap` is set.
 *  - Children are made `shrink-0 whitespace-nowrap` via child selectors, so
 *    call-sites don't need to touch every pill.
 *  - Pass layout extras (gap-*, mb-*, text-*) through `className`.
 */
export default function TabScroller({ children, className = '' }: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-nowrap overflow-x-auto md:flex-wrap md:overflow-visible no-scrollbar ` +
                    `-mx-1 px-1 [&>*]:shrink-0 [&>*]:whitespace-nowrap ${className}`}>
      {children}
    </div>
  );
}
