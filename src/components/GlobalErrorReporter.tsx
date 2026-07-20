'use client';

/**
 * Catches errors that React error boundaries CAN'T — uncaught errors in event
 * handlers, timers, and async code, plus unhandled promise rejections — and
 * reports them so an admin is alerted. Renders nothing; mounted once at the app
 * root. Purely additive; failures degrade to silence.
 */
import { useEffect } from 'react';
import { reportClientError } from '@/lib/report-error-client';

export default function GlobalErrorReporter() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      try {
        const err: any = e.error;
        reportClientError({
          message: err?.message || e.message || 'window.onerror',
          stack: err?.stack || (e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : ''),
        });
      } catch { /* ignore */ }
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      try {
        const r: any = e.reason;
        reportClientError({
          message: r?.message ? `Unhandled rejection: ${r.message}` : `Unhandled rejection: ${String(r).slice(0, 300)}`,
          stack: r?.stack || '',
        });
      } catch { /* ignore */ }
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
  return null;
}
