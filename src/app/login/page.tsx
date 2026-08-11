import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { homePathFor } from '@/lib/page-catalog';
import LoginForm from './LoginForm';

/**
 * /login — sign-in screen, with an ALREADY-SIGNED-IN guard.
 *
 * Why the guard exists. Nothing here ever logged anyone out: destroySession()
 * is only reached by the POST /api/auth/logout route and by the 30-day expiry
 * branch inside getCurrentUser — a Back navigation reaches neither, and the
 * cookie survives it intact. What actually happened is that the form used
 * router.push after a successful sign-in, so /login stayed parked one entry
 * below the app for the rest of the session; pressing Back re-rendered a bare
 * sign-in form to a fully authenticated user, which reads as "it logged me
 * out". LoginForm now uses router.replace, which stops NEW history from being
 * poisoned — but every tablet already in the field has a /login entry sitting
 * in its stack right now. This guard is what heals those without anyone
 * touching the devices: the stale entry resolves server-side to the user's
 * role-aware home instead of a login form.
 *
 * ACCOUNT SWITCHING. Front-of-house tablets are shared, so the guard must not
 * become a trap. `/login?switch=1` always renders the form, whoever is signed
 * in. The normal Logout buttons do not need it — POST /api/auth/logout deletes
 * the cookie before navigating here, so the guard sees no session and the form
 * renders as it always did. `?switch=1` is the escape for the case where that
 * POST failed (all three Logout handlers swallow the error and navigate anyway)
 * and for a deliberate hand-over without signing out first.
 *
 * This page NEVER clears a session. The guard only reads it.
 */
export const dynamic = 'force-dynamic';

/** A `next` value we are willing to redirect a signed-in user to: a local
 *  absolute path only — no cross-origin (`//host`), no backslash trick, and
 *  never back to /login itself (that would loop against this guard). */
function safeNext(raw: string | undefined): string | null {
  if (!raw || !raw.startsWith('/')) return null;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return null;
  if (raw === '/login' || raw.startsWith('/login?') || raw.startsWith('/login/')) return null;
  return raw;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  // Presence is enough — `?switch=1` and a bare `?switch` both mean "let me in".
  const wantsSwitch = sp.switch !== undefined;
  const me = await getCurrentUser();

  if (me && !wantsSwitch) {
    const rawNext = Array.isArray(sp.next) ? sp.next[0] : sp.next;
    // homePathFor returns '/login' for a signed-in user with no openable page.
    // Redirecting there would loop, so fall through and show the form instead —
    // signing in as someone else is the only useful thing left on that account.
    const home = homePathFor(me);
    const target = safeNext(rawNext) ?? (home === '/login' ? null : home);
    if (target) redirect(target);
  }

  return (
    <Suspense fallback={<div className="min-h-screen bg-[#FFF8F0]" />}>
      <LoginForm switchingFrom={me && wantsSwitch ? (me.name || me.email) : undefined} />
    </Suspense>
  );
}
