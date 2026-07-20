/**
 * Instant skeleton for the order screen — header + menu list — shown the moment a
 * table is tapped, while the order + menu load (the menu also paints from cache).
 */
export default function Loading() {
  return (
    <div className="min-h-screen bg-[#FFF8F0] animate-pulse">
      <div className="h-[52px] bg-white border-b border-[#E8D5C4] flex items-center gap-3 px-3">
        <div className="w-6 h-6 rounded bg-[#FFF1E3]" />
        <div className="h-4 w-32 bg-[#FFF1E3] rounded" />
        <div className="ml-auto h-4 w-16 bg-[#FFF1E3] rounded" />
      </div>
      <div className="p-3 sm:p-4 space-y-2.5">
        <div className="h-11 bg-white border border-[#E8D5C4] rounded-xl" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-16 bg-white border border-[#E8D5C4] rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
