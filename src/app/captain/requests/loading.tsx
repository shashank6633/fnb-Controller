/** Instant skeleton for the Orders & Requests board while it loads. */
export default function Loading() {
  return (
    <div className="min-h-screen bg-[#FFF8F0] p-4 sm:p-6 animate-pulse">
      <div className="h-7 w-48 bg-[#FFF1E3] rounded-lg" />
      <div className="mt-5 space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-28 bg-white border border-[#E8D5C4] rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
