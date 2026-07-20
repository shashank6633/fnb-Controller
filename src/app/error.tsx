'use client';

/**
 * App-level error boundary. Catches render errors in any route segment that
 * doesn't have its own error.tsx, showing a friendly recover-or-reload panel
 * (inside the normal app chrome) instead of a white screen. Reports the error so
 * an admin is alerted.
 */
import { useEffect } from 'react';
import { reportClientError } from '@/lib/report-error-client';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError({ message: error?.message || 'Render error', stack: error?.stack });
  }, [error]);

  return (
    <div className="min-h-[70vh] flex items-center justify-center p-6 bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-md text-center">
        <div className="text-5xl leading-none">⚠️</div>
        <h1 className="text-xl font-bold mt-3">Something went wrong</h1>
        <p className="text-sm text-[#6B5744] mt-1.5 leading-relaxed">
          This page hit an unexpected error. Your data is safe — an admin has been notified automatically. Try again, or reload.
        </p>
        <div className="flex gap-2 justify-center mt-5">
          <button onClick={() => reset()} className="px-4 py-2.5 bg-white border border-[#E8D5C4] text-[#6B5744] rounded-xl text-sm font-semibold hover:bg-[#FFF1E3] transition-colors">
            Try again
          </button>
          <button onClick={() => { try { location.reload(); } catch { /* ignore */ } }} className="px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-xl text-sm font-semibold transition-colors">
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}
