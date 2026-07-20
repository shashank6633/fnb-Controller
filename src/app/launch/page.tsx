import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { homePathFor } from '@/lib/page-catalog';

/**
 * /launch — role-aware entry point.
 *
 * The Captain APK (and any PWA install) opens this instead of a fixed page, so
 * ONE app serves every role: it resolves the signed-in user's natural home
 * (management → dashboard, GRE → Recovery Queue, captain → POS, kitchen → KDS…)
 * and redirects there. Not signed in → login, which returns here afterwards.
 *
 * Allowlisted in page-catalog ALWAYS_ALLOWED so the proxy lets it through for
 * every role (it only redirects — shows nothing). Server-side, so no flash.
 */
export const dynamic = 'force-dynamic';

export default async function LaunchPage() {
  const me = await getCurrentUser();
  if (!me) redirect('/login?next=/launch');
  const home = homePathFor(me);
  // homePathFor → '/login' means "signed in but no page opens for you" — don't
  // bounce back to the login form (a soft loop); show clear guidance instead.
  if (home === '/login') {
    return (
      <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: '#FFF8F0', color: '#2D1B0E', textAlign: 'center' }}>
        <div style={{ maxWidth: 380 }}>
          <p style={{ fontSize: 18, fontWeight: 600 }}>No pages are assigned to your account</p>
          <p style={{ marginTop: 8, color: '#8B7355', fontSize: 14 }}>Please ask your administrator to grant you access, then reopen the app.</p>
        </div>
      </main>
    );
  }
  redirect(home);
}
