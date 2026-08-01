import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { isTelecmiConfigured } from '@/lib/ct/settings';
import { fetchBalance } from '@/lib/ct/telecmi-api';

/**
 * GET /api/telecmi/balance — admin-only prepaid balance + SMS credits.
 *
 * Shape (always HTTP 200 unless auth fails):
 *   { configured, balance, sms, expire, error? }
 *
 * ── WHY EVERY FAILURE IS STILL A 200 ───────────────────────────────────────
 * This feeds a small panel on the CRM settings screen. A 500 there renders as
 * a broken widget with no explanation, and the one thing an owner needs from a
 * balance panel is to know WHY it cannot tell them the balance — "not
 * configured" and "TeleCMI did not respond" are completely different problems
 * with completely different fixes. So the route answers 200 with nulls plus a
 * human-readable `error`, and the panel prints it.
 *
 * ── WHY NULL, NEVER 0 ──────────────────────────────────────────────────────
 * A balance of 0 shown as fact when we simply could not reach TeleCMI is worse
 * than showing nothing: 0 means "top up now", unknown means "we don't know".
 * Callers distinguish them by `balance === null`.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0; // a cached balance is a lie — it is spend-tracking money

/** TeleCMI occasionally sends numerics as strings; anything unparseable is
 *  unknown, and unknown is null (see the null-never-0 note above). */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function GET() {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  const db = getDb();

  // Not configured is a STATE, not an error: the panel renders "not configured"
  // with a link to the credentials form. Sending an error string here would put
  // a red failure box in front of an owner who has simply not set it up yet.
  if (!isTelecmiConfigured(db)) {
    return Response.json({ configured: false, balance: null, sms: null, expire: null });
  }

  const res = await fetchBalance(db);
  if (!res.ok || !res.data) {
    // res.error is built by telecmi-api and never contains the appid or secret.
    return Response.json({
      configured: true,
      balance: null,
      sms: null,
      expire: null,
      error: res.error || 'TeleCMI did not return a balance',
    });
  }

  return Response.json({
    configured: true,
    balance: numOrNull(res.data.balance),
    sms: numOrNull(res.data.sms),
    expire: numOrNull(res.data.expire),
  });
}
