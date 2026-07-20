'use client';

/**
 * Captain app error boundary. A POS in the middle of service must never show a
 * white screen — a crash here drops to a reassuring, touch-friendly recover
 * panel (light theme, matches the app) and reports the error so an admin is
 * alerted. Open tables/orders live on the server, so a reload restores them.
 */
import { useEffect } from 'react';
import { reportClientError } from '@/lib/report-error-client';

export default function CaptainError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError({ message: error?.message || 'Captain render error', stack: error?.stack, source: 'captain' });
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-[#FFF8F0] text-[#2D1B0E] select-none">
      <div className="max-w-sm text-center">
        <div className="text-5xl leading-none">⚠️</div>
        <h1 className="text-xl font-bold mt-3">Something went wrong</h1>
        <p className="text-sm text-[#6B5744] mt-1.5 leading-relaxed">
          Your open tables and orders are safe. Reload to keep taking orders — an admin has been notified automatically.
        </p>
        <div className="flex gap-2 justify-center mt-5">
          <button onClick={() => reset()} className="px-4 py-3 bg-white border border-[#E8D5C4] text-[#6B5744] rounded-xl text-sm font-semibold active:scale-95">
            Try again
          </button>
          <button onClick={() => { try { location.reload(); } catch { /* ignore */ } }} className="px-5 py-3 bg-[#af4408] text-white rounded-xl text-sm font-semibold active:scale-95">
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}
