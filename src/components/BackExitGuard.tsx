'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { homePathFor } from '@/lib/page-catalog';

/**
 * Android Back at the app's FIRST screen: home first, then "press back again
 * to exit".
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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOME BEFORE EXIT (the owner's cashier rule, 2026-08-12)
 *
 * "For Cashier Login … from any page if he goes back it should go to cashier
 * page." Read literally that would mean hijacking every Back press, which would
 * break backing out of a bill into the table list — there are ~45
 * `router.back()` call sites across 27 files and every one of them must keep
 * working. What the owner is describing is the DEAD END: a cashier who has
 * backed all the way down should arrive at the till, not at whatever screen the
 * app happened to open on, and certainly not at a closed app.
 *
 * So the bottom-of-history press — and ONLY that press, the same one that
 * already showed the exit hint — now asks first: are we standing on this user's
 * home (homePathFor, the same function /launch and the /login guard use)? If
 * not, it carries them there with a `router.replace` and re-arms. If yes, it
 * behaves exactly as before: hint, and a second press within 2s exits. A
 * cashier therefore gets Back → the cashier console → hint → exit; a captain,
 * whose home IS /captain and who normally opens there, sees no change at all.
 *
 * Two properties keep this from becoming a trap:
 *   - the send-home fires AT MOST ONCE per document. If the replace does not
 *     stick (a redirect elsewhere, anything), the next bottom press falls
 *     straight through to the exit hint, so Back can always still close the app.
 *   - a home is only ever used when /api/auth/me answered. Unknown home, or
 *     homePathFor's '/login' ("no page opens for you"), means the guard behaves
 *     exactly as it did before this paragraph existed.
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

/**
 * Tag the entry we are standing on as the bottom and park the user one step up.
 * Returns false if `history` refused, in which case the guard stays disarmed
 * and Back behaves exactly as it does without this component.
 */
function tagBottomAndPushSpare(): boolean {
  try {
    // Tag the bottom entry, keeping Next's own state (__NA + its internal
    // tree) intact — Next reloads the page on a popstate to an entry without
    // __NA, and a traverse preserves custom keys, so both tags survive.
    window.history.replaceState({ ...(window.history.state || {}), [BOTTOM_KEY]: true }, '');
    // Park the user one step up. No url argument => same URL, nothing visible
    // changes and Next's router is not asked to navigate.
    window.history.pushState(spareState(), '');
    return true;
  } catch { return false; }
}

export default function BackExitGuard() {
  const pathname = usePathname();
  const router = useRouter();
  const [showToast, setShowToast] = useState(false);
  const armedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** This user's home page (homePathFor), once /api/auth/me has answered.
   *  null = unknown; the guard then behaves exactly as it did before. */
  const homeRef = useRef<string | null>(null);
  /** True once we have carried this user home from the bottom entry. Never
   *  done twice: if the first attempt did not land them on home, a second try
   *  would make Back unable to ever close the app. */
  const sentHomeRef = useRef(false);
  /** Set between "we asked the router to go home" and the effect below
   *  re-tagging the bottom entry, with the path we expect to arrive at. */
  const rearmToRef = useRef<string | null>(null);

  // Arm once, on the first non-/login screen of an installed app that owns the
  // bottom of its history. /login is skipped deliberately: sign-in finishes with
  // router.replace, which would swap the page out from under a spare entry and
  // leave a /login entry as the bottom — exactly the thing we are removing.
  useEffect(() => {
    if (pathname === '/login') {
      // A visit to /login means the identity can be about to change — an
      // account handover on a shared tablet via /login?switch=1. homeRef is
      // otherwise written once and never invalidated, so without this the
      // guard would keep carrying the NEXT person to the PREVIOUS person's
      // home. Drop everything learned and let the guard arm again afterwards.
      homeRef.current = null;
      sentHomeRef.current = false;
      rearmToRef.current = null;
      armedRef.current = false;
      return;
    }
    if (!isInstalledApp()) return;

    if (armedRef.current) {
      // RE-ARM after a send-home. router.replace rewrote the bottom entry's
      // state with Next's own, which took our tag with it; without this the
      // next Back on the home page would close the app with no hint. There is
      // deliberately no history.length test here: the user has navigated since
      // arming, so the stack is longer than one, and the entry they are
      // standing on IS the bottom — they arrived on it by popstate.
      const want = rearmToRef.current;
      if (!want) return;
      // Only re-tag once we have actually arrived where we aimed. Landing
      // anywhere else means the replace was redirected; leave the guard as it
      // is rather than tagging a random entry as "the bottom".
      // Consume the intent ONLY on arrival. Clearing it first meant that any
      // unrelated re-render of this effect between the popstate and the
      // deferred replace landing threw the intent away, leaving the new bottom
      // entry untagged — and an untagged bottom silently disables the guard.
      if (pathname === want) {
        rearmToRef.current = null;
        tagBottomAndPushSpare();
      }
      return;
    }

    if (window.history.length !== 1) return;
    if (!tagBottomAndPushSpare()) return;   // history unavailable → stay disarmed
    armedRef.current = true;

    // Learn where this user's home is, so a Back at the bottom can carry them
    // there instead of closing the app. Once per document, and only here —
    // inside the installed-app + armed branch — so a browser tab (the counter
    // PC, any desktop) issues no request at all. If it fails, or is still in
    // flight when Back is pressed, homeRef stays null and the press falls
    // through to the exit hint, exactly as before.
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        const home = d?.user ? homePathFor(d.user) : null;
        // homePathFor returns '/login' for "signed in but no page opens for
        // you". Carrying someone to a sign-in form on Back would read as being
        // logged out — the exact bug the /login guard was shipped to kill.
        homeRef.current = home && home !== '/login' ? home : null;
      })
      .catch(() => { /* no home known — the exit hint stays the behaviour */ });
  }, [pathname]);

  useEffect(() => {
    const onPopState = (e: PopStateEvent) => {
      if (!armedRef.current) return;
      // Only the tagged bottom entry means "the user is trying to leave".
      // Every other entry is a real page they navigated back to.
      if (!(e.state as Record<string, unknown> | null)?.[BOTTOM_KEY]) return;

      // ── BOTTOM OF HISTORY. Home first, exit second (see the header).
      // window.location is read live rather than closed over: this listener is
      // registered once, so a captured `pathname` would be the one from mount.
      const home = homeRef.current;
      const here = window.location.pathname;
      if (home && here === home) {
        // Standing on their own home page — this is the exit case, and it also
        // clears the one-shot so a later wander-and-back-out is carried home
        // again.
        sentHomeRef.current = false;
      } else if (home && !sentHomeRef.current) {
        sentHomeRef.current = true;
        rearmToRef.current = home;
        setShowToast(false);
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
        // A replace, not a push: it rewrites this bottom entry so home BECOMES
        // the bottom. A push would leave the old page underneath, and the next
        // Back would drop onto it again — the user could never reach the exit.
        //
        // DEFERRED OUT OF THE POPSTATE TASK, and this is load-bearing. Next's
        // app-router listens for the same popstate and dispatches its own
        // RESTORE for the entry we just landed on. Calling router.replace
        // synchronously from here loses that race: MEASURED in the dev app
        // 2026-08-12 — the RSC payload for the home page was fetched (200) and
        // the entry's state was rewritten, but the URL never moved off the old
        // page. A zero timeout runs after the popstate task, so the restore is
        // finished and the replace is the last word.
        setTimeout(() => { router.replace(home); }, 0);
        return;
      }
      // Falls through when: home is unknown, or we already tried once and are
      // still not on it. Either way the press means exit — never redirect a
      // second time, or Back could never close the app.

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
    // `router` only so the handler never closes over a stale instance; the
    // App Router's object is stable, so in practice this binds once.
  }, [router]);

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
