'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Android Back at the app's FIRST screen: "press back again to exit".
 *
 * The problem. The Captain APK is a TWA whose startUrl is /launch
 * (captain-android/twa-manifest.json). /launch redirects server-side on the
 * very first document, so a redirect — not a new entry — lands the user on
 * their role home: the tab holds exactly ONE history entry. Pressing Back there
 * has nothing beneath it, so Android closes the app instantly, mid-shift, with
 * no warning. Making the sign-in redirect a `replace` (which it now is) removes
 * the stale /login entry that used to sit underneath, so this became the ONLY
 * thing standing between a stray Back tap and a closed till.
 *
 * How it works. When the app is the bottom of its own history we tag that
 * bottom entry and push a second, IDENTICAL entry (same URL, no visible
 * change) on top of it. The user then lives one step up, so their next Back
 * produces a `popstate` we can see instead of an app exit. Landing back on the
 * tagged bottom entry is the exit signal: we show a toast and deliberately do
 * NOT push the spare entry back on, which leaves the user standing on the true
 * bottom — so a second Back within the window closes the app exactly as it
 * always did, with no JavaScript involved. If that second press never comes,
 * the spare entry is restored and the guard is armed again.
 *
 * Why this cannot swallow a legitimate in-app Back:
 *   - It only arms when `history.length === 1` — i.e. there is nothing below us
 *     to go back TO. Any deeper stack is left completely alone.
 *   - It only arms in an installed/TWA display mode. In an ordinary browser tab
 *     (the counter PC, any desktop) it never installs anything at all, so all
 *     45 `router.back()` call sites across 27 files behave exactly as before.
 *   - The popstate handler reacts ONLY when the entry it landed on carries our
 *     bottom tag. Backing out of /tasks, /crm, a cashier bill or anywhere else
 *     lands on a normal entry, which the handler ignores.
 *   - The one overlap is a page's own Back button pressed on the very first
 *     screen with nothing above it — where `router.back()` today does literally
 *     nothing. That press now shows the exit hint instead of being dead.
 *
 * If the bottom tag is ever lost — history unavailable, or a page clearing its
 * own query string with `history.replaceState({}, …)` while sitting on that
 * entry, as /party-events and /party-requisitions do — the guard simply stops
 * firing and Back closes the app exactly as it does today. It can never leave
 * the user stuck.
 */

/** Tag on the true bottom history entry — landing on it means "exit intent". */
const BOTTOM_KEY = '__fnbExitBottom';
/** Tag on the spare entry we park the user on. Diagnostic only; the handler
 *  keys off BOTTOM_KEY's absence, so losing this tag changes nothing. */
const SPARE_KEY = '__fnbExitSpare';
/** How long the second Back press counts as "yes, really exit". */
const EXIT_WINDOW_MS = 2000;

/**
 * State for the spare entry, CARRYING NEXT'S OWN STATE FORWARD.
 *
 * This must not be a fresh object. Next stores `__NA` and its internal segment
 * tree on every history entry it owns, and its popstate handler HARD-RELOADS
 * the document when it traverses onto an entry that lacks `__NA`
 * (node_modules/next/dist/client/components/app-router.js). A bare
 * `pushState({ spare: true })` therefore looks fine until the user navigates
 * one page deeper and presses Back: they land on the spare and the whole app
 * reloads. Spreading the live state keeps the entry indistinguishable from one
 * Next made itself.
 *
 * BOTTOM_KEY is stripped deliberately. The spare is created while the user
 * stands on the freshly-tagged bottom entry, so a plain spread would copy that
 * tag upward and the popstate handler would read the spare as the bottom —
 * firing the exit toast one press early, on a Back that should have navigated.
 */
function spareState(): Record<string, unknown> {
  const live = { ...((window.history.state as Record<string, unknown> | null) || {}) };
  delete live[BOTTOM_KEY];
  return { ...live, [SPARE_KEY]: true };
}

/** Installed app (TWA / PWA) rather than a browser tab. A TWA reports
 *  display-mode: standalone and an android-app:// referrer on its first
 *  document; iOS home-screen installs set navigator.standalone. */
function isInstalledApp(): boolean {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
    if (window.matchMedia?.('(display-mode: fullscreen)').matches) return true;
    if ((window.navigator as unknown as { standalone?: boolean }).standalone === true) return true;
    if (document.referrer.startsWith('android-app://')) return true;
  } catch { /* matchMedia unavailable — treat as a plain browser tab */ }
  return false;
}

export default function BackExitGuard() {
  const pathname = usePathname();
  const [showToast, setShowToast] = useState(false);
  const armedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Arm once, on the first non-/login screen of an installed app that owns the
  // bottom of its history. /login is skipped deliberately: sign-in finishes with
  // router.replace, which would swap the page out from under a spare entry and
  // leave a /login entry as the bottom — exactly the thing we are removing.
  useEffect(() => {
    if (armedRef.current) return;
    if (pathname === '/login') return;
    if (!isInstalledApp()) return;
    if (window.history.length !== 1) return;
    try {
      // Tag the bottom entry, keeping Next's own state (__NA + its internal
      // tree) intact — Next reloads the page on a popstate to an entry without
      // __NA, and a traverse preserves custom keys, so both tags survive.
      window.history.replaceState({ ...(window.history.state || {}), [BOTTOM_KEY]: true }, '');
      // Park the user one step up. No url argument => same URL, nothing visible
      // changes and Next's router is not asked to navigate.
      window.history.pushState(spareState(), '');
      armedRef.current = true;
    } catch { /* history unavailable — leave Back exactly as it is today */ }
  }, [pathname]);

  useEffect(() => {
    const onPopState = (e: PopStateEvent) => {
      if (!armedRef.current) return;
      // Only the tagged bottom entry means "the user is trying to leave".
      // Every other entry is a real page they navigated back to.
      if (!(e.state as Record<string, unknown> | null)?.[BOTTOM_KEY]) return;
      // We are now standing on the true bottom: the next hardware Back exits.
      const hrefAtPress = window.location.href;
      setShowToast(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setShowToast(false);
        // Re-arm — unless the user navigated during the window, in which case
        // pushing a spare entry would strand a phantom entry on top of the page
        // they just opened.
        if (window.location.href !== hrefAtPress) return;
        try { window.history.pushState(spareState(), ''); } catch { /* leave disarmed */ }
      }, EXIT_WINDOW_MS);
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (!showToast) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-6 z-[9999] flex justify-center px-4 pointer-events-none"
    >
      <div className="rounded-full bg-[#1C0F05] text-white text-sm px-4 py-2 shadow-lg">
        Press back again to exit
      </div>
    </div>
  );
}
