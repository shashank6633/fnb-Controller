'use client';

/**
 * Root error boundary — the last line of defence. Catches errors thrown by the
 * ROOT layout itself (where a normal error.tsx can't reach), so a fatal render
 * error shows this friendly screen instead of a blank white page. It must render
 * its own <html>/<body> and use inline styles (Tailwind/global CSS may not have
 * loaded when the root crashes).
 */
import { useEffect } from 'react';
import { reportClientError } from '@/lib/report-error-client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError({ message: error?.message || 'Root render error', stack: error?.stack, source: 'web' });
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, -apple-system, sans-serif', background: '#FFF8F0', color: '#2D1B0E' }}>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ maxWidth: 420, textAlign: 'center' }}>
            <div style={{ fontSize: 48, lineHeight: 1 }}>⚠️</div>
            <h1 style={{ fontSize: 20, fontWeight: 700, margin: '14px 0 6px' }}>Something went wrong</h1>
            <p style={{ color: '#6B5744', fontSize: 14, lineHeight: 1.55, margin: 0 }}>
              The app hit an unexpected error. Your data is safe. Please reload — an admin has been notified automatically.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 18 }}>
              <button
                onClick={() => reset()}
                style={{ background: '#fff', border: '1px solid #E8D5C4', color: '#6B5744', padding: '10px 16px', borderRadius: 12, fontWeight: 600, cursor: 'pointer' }}
              >
                Try again
              </button>
              <button
                onClick={() => { try { location.reload(); } catch { /* ignore */ } }}
                style={{ background: '#af4408', border: 'none', color: '#fff', padding: '10px 16px', borderRadius: 12, fontWeight: 600, cursor: 'pointer' }}
              >
                Reload app
              </button>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
