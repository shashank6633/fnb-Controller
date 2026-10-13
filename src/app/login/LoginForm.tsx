'use client';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Eye, EyeOff, Loader2, LogIn, ShieldCheck, UserCog } from 'lucide-react';

/**
 * The sign-in form. Split out of page.tsx so that page.tsx can be a SERVER
 * component and run the already-signed-in guard before this ever renders
 * (see the header comment in page.tsx).
 *
 * useSearchParams() must sit inside a Suspense boundary — page.tsx provides it.
 */
export default function LoginForm({ switchingFrom }: { switchingFrom?: string }) {
  const router = useRouter();
  const params = useSearchParams();
  // Default to the role-aware launcher so every user lands on their own home
  // (management → dashboard, GRE → recovery, captain → POS…), not a fixed page.
  // Restrict `next` to a LOCAL absolute path — reject cross-origin (//host),
  // backslash tricks, and javascript: URIs so ?next= can't open-redirect.
  const rawNext = params.get('next');
  const next = rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//') && !rawNext.startsWith('/\\')
    ? rawNext
    : '/launch';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Peek at the password while typing. Front-of-house tablets are shared and
  // the on-screen keyboard hides half the screen, so a typo in a masked field
  // is the commonest reason a sign-in fails twice. STARTS HIDDEN, is never
  // persisted, and re-hides on submit so a revealed password cannot be left on
  // screen for the next person on a shared device.
  const [showPassword, setShowPassword] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    // Re-mask before the request goes out. On a shared front-of-house tablet a
    // revealed password would otherwise stay on screen through the round trip,
    // and stay there in full if the sign-in fails.
    setShowPassword(false);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!r.ok) { setError((await r.json()).error || 'Login failed'); return; }
      // REPLACE, not push: otherwise /login stays parked one entry below the app
      // for the whole session, and Back from the home screen renders a sign-in
      // form to a user who is still fully signed in ("it logged me out" — it
      // didn't; the cookie is untouched). Replacing drops /login off the stack.
      router.replace(next);
    } catch (err: any) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center p-4">
      <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-xl p-8 w-full max-w-sm space-y-5">
        <div className="text-center">
          <div className="w-12 h-12 rounded-xl bg-[#af4408] text-white flex items-center justify-center mx-auto mb-3">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <h1 className="text-xl font-bold text-[#2D1B0E]">F&amp;B Controller</h1>
          <p className="text-xs text-[#8B7355] mt-1">Sign in to continue</p>
        </div>

        {/* Shared front-of-house tablet: someone is still signed in and has asked
            to hand over. Say whose session is live so nobody signs in on top of
            a colleague by accident. The old session stays valid until this form
            is submitted — nothing here signs anyone out. */}
        {switchingFrom && (
          <div className="flex items-start gap-2 text-[11px] text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg px-3 py-2">
            <UserCog className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[#af4408]" />
            <span>Currently signed in as <strong className="text-[#2D1B0E]">{switchingFrom}</strong>. Signing in below switches this device to another account.</span>
          </div>
        )}

        <form onSubmit={submit} className="space-y-3">
          <label className="block text-xs text-[#6B5744]">
            Email
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus
                   className="w-full mt-1 px-3 py-2 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
          </label>
          <label className="block text-xs text-[#6B5744]">
            Password
            {/* The eye sits INSIDE a relative wrapper rather than beside the
                input, so the field keeps its full width and the icon cannot be
                pushed onto a second line on a narrow phone. pr-10 reserves the
                space so a long password never runs underneath it. */}
            <div className="relative mt-1">
              <input type={showPassword ? 'text' : 'password'} value={password}
                     onChange={e => setPassword(e.target.value)} required
                     autoComplete="current-password"
                     className="w-full px-3 py-2 pr-10 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
              {/* type="button" is load-bearing: the default inside a <form> is
                  "submit", so without it a peek would try to sign you in.
                  tabIndex={-1} keeps Tab going Email → Password → Sign in, the
                  order muscle memory expects; the control is still reachable by
                  touch and by screen readers, which is what it is for. */}
              <button type="button" tabIndex={-1}
                      onClick={() => setShowPassword(v => !v)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      aria-pressed={showPassword}
                      title={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute inset-y-0 right-0 flex items-center justify-center w-10 text-[#8B7355] hover:text-[#af4408]">
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </label>
          {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
          <button type="submit" disabled={busy}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />} Sign in
          </button>
        </form>

        <p className="text-center text-[11px] text-[#8B7355] italic tracking-wide pt-1 border-t border-[#F0E2D2]">
          <span className="block pt-3">From purchase to plate — fully in control.</span>
        </p>
      </div>
    </div>
  );
}
