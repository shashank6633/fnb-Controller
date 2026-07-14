import type { Database } from 'better-sqlite3';
import { todayIST } from '@/lib/format-date';

/**
 * Configurable backdate window for purchase-type date entry.
 *
 * Applies to single Purchase entry, Bulk Bill import (per line), and GRN receipt
 * dates. A non-admin may only save a date within the last N days (inclusive) and
 * never a future date. Admins (role === 'admin') are fully EXEMPT — they can
 * enter any date, older than N or in the future.
 *
 * The limit N is stored in the settings KV under `purchase_backdate_limit_days`
 * (default "3", seeded in db.ts). It is admin/manager-editable via /api/settings.
 *
 * Dates are YYYY-MM-DD strings. "Today" is IST (todayIST()) — NOT UTC — so the
 * day boundary matches the rest of the app. Same-format YYYY-MM-DD strings
 * compare correctly lexicographically, so the cutoff is computed by parsing
 * todayIST, subtracting N days, and re-formatting as YYYY-MM-DD.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Read the configured backdate limit in days (default 3, floored at 0). */
export function getBackdateLimitDays(db: Database): number {
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get('purchase_backdate_limit_days') as
      | { value?: string }
      | undefined;
    const n = parseInt(String(r?.value ?? '3'), 10);
    if (!Number.isFinite(n) || n < 0) return 0;
    return n;
  } catch {
    return 3;
  }
}

/** Subtract `days` from a YYYY-MM-DD string and return YYYY-MM-DD (UTC math on the date-only value). */
function subtractDays(ymd: string, days: number): string {
  // Parse as a UTC midnight so the arithmetic never crosses a DST/local boundary;
  // we only ever read back the date part, which is timezone-agnostic here.
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export type PurchaseDateCheck = { ok: true } | { ok: false; error: string };

/**
 * Validate a purchase-type date against the configurable backdate window.
 *   - admin              → always ok (fully exempt).
 *   - missing/bad format → error.
 *   - future date        → error.
 *   - older than cutoff  → error (admin can override).
 */
export function checkPurchaseDate(db: Database, dateStr: unknown, isAdmin: boolean): PurchaseDateCheck {
  if (isAdmin) return { ok: true };

  const s = typeof dateStr === 'string' ? dateStr.trim() : '';
  if (!s || !DATE_RE.test(s)) {
    return { ok: false, error: 'A valid date (YYYY-MM-DD) is required.' };
  }

  const today = todayIST();
  if (s > today) {
    return { ok: false, error: 'Future dates are not allowed.' };
  }

  const n = getBackdateLimitDays(db);
  const cutoff = subtractDays(today, n);
  if (s < cutoff) {
    return {
      ok: false,
      error: `Backdating is limited to ${n} day(s). Date ${s} is older than the allowed window; an admin can override.`,
    };
  }

  return { ok: true };
}
