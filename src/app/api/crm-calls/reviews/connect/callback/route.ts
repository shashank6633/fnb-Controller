/* eslint-disable @typescript-eslint/no-explicit-any */
import { redirect } from 'next/navigation';
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { completeConnect, ensureReviewSchema, selectLocation } from '@/lib/reviews';

/**
 * CRM — the Google OAuth redirect target. GET only; Google decides when it is
 * called.
 *
 * This is the first OAuth callback route in this app. Everything Google-shaped
 * here already exists in the app as SERVICE-account auth (src/lib/sheets-client.ts
 * and a pasted google_sa_json), and that pattern DOES NOT TRANSFER: Business
 * Profile reviews require three-legged user OAuth as the account that manages
 * the listing. So this is new plumbing rather than a copy of something.
 *
 * ── THIS ROUTE ENDS IN A REDIRECT, NOT JSON ─────────────────────────────────
 * A browser lands here, not a fetch. Returning JSON would leave the owner
 * staring at a raw object after clicking Allow. So every path — success,
 * refusal, error — ends by sending him back to the reviews page with a
 * parameter the page renders. The outcome is never left on this URL.
 *
 * ── WHY THE SESSION IS CHECKED AGAIN ────────────────────────────────────────
 * The state parameter proves this callback belongs to a flow this app started,
 * and consuming its nonce proves it has not been replayed. Neither proves WHO
 * is holding the browser. Re-checking the admin session closes the case where a
 * consent URL is completed in someone else's browser — the tokens land on the
 * venue's Google account either way, so the person finishing the flow must be
 * the person allowed to start one.
 *
 * ── redirect() THROWS ───────────────────────────────────────────────────────
 * next/navigation's redirect() works by throwing NEXT_REDIRECT. Calling it
 * inside a try/catch would have that catch swallow the redirect and turn every
 * success into an error page. So every redirect below is issued OUTSIDE the
 * try, from a variable the try assigned.
 */

export const dynamic = 'force-dynamic';

const PAGE = '/crm-calls/reviews';

function back(params: Record<string, string>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) u.set(k, v.slice(0, 300));
  return `${PAGE}?${u.toString()}`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const googleError = url.searchParams.get('error') || '';

  // Google reports a refusal by query parameter, not by status code.
  if (googleError) {
    redirect(back({
      connect_error: googleError === 'access_denied'
        ? 'Google sign-in was cancelled, so nothing was connected.'
        : `Google refused the sign-in: ${googleError}`,
    }));
  }

  const me = await getCurrentUser();
  if (!me || me.role !== 'admin') {
    redirect(back({
      connect_error: 'Finish connecting while signed in to this app as an admin, in the same ' +
                     'browser that started the connection.',
    }));
  }

  let destination = '';
  try {
    const db = ensureReviewSchema(getDb());
    const result = await completeConnect(db, {
      code,
      state,
      actor: me.email || me.name || me.id,
    });

    // Convenience with a hard limit: when the account holds exactly ONE listing
    // there is nothing to choose, so choose it. With two or more, picking the
    // first would silently report another restaurant's reviews as this one's —
    // so the owner picks, always.
    const allLocations = result.accounts.flatMap(a => a.locations);
    let autoPicked = '';
    if (allLocations.length === 1) {
      try {
        selectLocation(db, {
          locationKey: result.locationKey,
          name: allLocations[0].name,
          label: allLocations[0].label,
          address: allLocations[0].address,
        });
        autoPicked = allLocations[0].label;
      } catch { /* fall through to the picker */ }
    }

    destination = back({
      connected: '1',
      google_email: result.googleEmail,
      picked: autoPicked,
      // Discovery failing does not undo a good connection. Most often it means
      // the Business Profile API application has not been approved yet — which
      // is paperwork, and the page should say so rather than "connect failed".
      discovery_error: result.discoveryError,
      needs_pick: !autoPicked && allLocations.length > 1 ? '1' : '',
    });
  } catch (e: any) {
    destination = back({ connect_error: String(e?.message || e) });
  }

  redirect(destination);
}
