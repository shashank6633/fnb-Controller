/**
 * Instant skeleton for the Captain home while the page + its data load — so a
 * tap shows the frame in a fraction of a second instead of a blank wait.
 */
export default function Loading() {
  return (
    <div className="min-h-screen bg-[#FFF8F0] p-4 sm:p-6 animate-pulse">
      <div className="h-8 w-40 bg-[#FFF1E3] rounded-lg" />
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-28 bg-white border border-[#E8D5C4] rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
