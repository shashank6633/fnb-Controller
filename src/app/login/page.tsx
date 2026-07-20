'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, LogIn, ShieldCheck } from 'lucide-react';

// useSearchParams() must be inside a Suspense boundary in Next.js 16 client
// components, otherwise static prerender fails. We split the form into a
// child component and wrap it in Suspense at the page root.
export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#FFF8F0]" />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!r.ok) { setError((await r.json()).error || 'Login failed'); return; }
      router.push(next);
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

        <form onSubmit={submit} className="space-y-3">
          <label className="block text-xs text-[#6B5744]">
            Email
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus
                   className="w-full mt-1 px-3 py-2 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
          </label>
          <label className="block text-xs text-[#6B5744]">
            Password
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required
                   className="w-full mt-1 px-3 py-2 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
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
