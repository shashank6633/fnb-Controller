'use client';

/**
 * PhaseShell — the honest screen an FSSAI sub-module shows before the phase that
 * builds it has run.
 *
 * WHY THIS EXISTS AT ALL. Twenty nav rows land in P1, and a catalogued path with
 * no page.tsx returns a 404 (proven by /dine-in/order, which is in the catalog
 * with no page) — so every one of the twenty needs a real page from day one. What
 * it must NOT do is look like a working compliance screen: a fake table of
 * readings on a food-safety page is worse than an empty one, because someone
 * could put it in front of an inspector. So this shell says, in plain words, that
 * the screen is not built yet, what it will do, what has to be built first, and
 * where the work is written down TODAY if it is written down anywhere.
 *
 * TWO RULES ABOUT THE WORDS, both learned the hard way:
 *   1. No "Phase N" anywhere a person reads. The build plan's numbers live in
 *      modules.ts and stay there; the screen says what is being built, not which
 *      numbered phase builds it.
 *   2. Nothing here may read as a statement about the RESTAURANT's compliance.
 *      These screens describe the SOFTWARE. A screen that will be handed to an
 *      outsider passes its own `notice` — see the prop below.
 *
 * It is styled off the house page skeleton (docs/fssai/RECON.md §1.3): the
 * #FFF8F0 page, the #af4408 brand heading with an icon tile, white cards with a
 * #E8D5C4 border, and the amber notice panel this app already uses for "you
 * cannot do this here" messages. Nothing new is invented.
 *
 * Labels, icons, phases and the Management/Admin marks all come from
 * ./modules.ts, which holds the same twenty strings as Sidebar.tsx and
 * page-catalog.ts — so a heading cannot drift from the menu row that leads to it.
 */

import { ArrowLeft, ArrowRight, Hourglass, Lock } from 'lucide-react';
import {
  FSSAI_BUILD_HELD_AT_REVIEW_GATE,
  FSSAI_REVIEW_GATE_PHASE,
  fssaiAccessLabel,
  fssaiModule,
  fssaiPhase,
} from './modules';

export interface PhaseShellLink {
  href: string;
  /** Use the app's own menu wording so he can find the screen in the sidebar. */
  label: string;
}

export interface PhaseShellProps {
  /** This page's own path — the key into modules.ts. */
  href: string;
  /** Overrides the menu label as the heading. Only the dashboard needs this. */
  title?: string;
  /** What the screen will do once built. One plain sentence per line. */
  will: string[];
  /** Where this work is recorded today, if anywhere in the app already covers it. */
  today?: { text: string; links?: PhaseShellLink[] };
  /** Anything the owner should know now — an assumption made, a limit, a question. */
  notes?: string[];
  /**
   * Replaces the amber headline for a screen that cannot safely carry the
   * default one.
   *
   * THE ONE SCREEN THAT NEEDS THIS IS INSPECTION MODE, and the reason is worth
   * keeping: it is the screen designed to be held out to a visiting officer. The
   * default headline is written for the OWNER, about a SCREEN — but read over
   * somebody's shoulder it sounds like the RESTAURANT has no records, which is a
   * different and much more damaging claim. Any future screen meant to be shown
   * to an outsider must pass its own notice too. See FSSAI-BUILD-STATE.md §7 Q11.
   */
  notice?: { title: string; body: string };
}

export default function PhaseShell({ href, title, will, today, notes, notice }: PhaseShellProps) {
  const mod = fssaiModule(href);
  const phase = fssaiPhase(mod.phase);
  const Icon = mod.icon;
  const accessLabel = fssaiAccessLabel(mod.access);
  /* TWO CONDITIONS, NOT ONE, and both are load-bearing.
   *
   * `FSSAI_BUILD_HELD_AT_REVIEW_GATE` is the owner's instruction: he asked for
   * the build to stop after the phone checklist, then asked for it to carry on.
   * While it is false, no screen claims its work is on hold — a sentence that
   * was true in September and is not true now.
   *
   * `!notice` is the older rule and the reason is on the `notice` prop itself: a
   * screen that passes its own headline is one meant to be read by somebody
   * OUTSIDE the business (Inspection Mode is the case it was written for), and
   * a paragraph about our internal build order has no business on it. */
  const heldBehindReview = FSSAI_BUILD_HELD_AT_REVIEW_GATE && mod.phase >= FSSAI_REVIEW_GATE_PHASE && !notice;

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* Header — icon tile + eyebrow + title + one-line purpose */}
        <div className="flex flex-wrap items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <Icon size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">
              FSSAI Compliance
            </p>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">{title || mod.label}</h1>
            {mod.blurb && <p className="text-sm text-[#6B5744] mt-1">{mod.blurb}</p>}
          </div>
          {accessLabel && (
            <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border bg-purple-100 text-purple-700 border-purple-200">
              <Lock className="w-3 h-3" /> {accessLabel}
            </span>
          )}
        </div>

        {/* The honest notice. This is the whole point of the screen. */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <Hourglass className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="font-bold text-amber-900">
                {notice ? notice.title : 'This screen is not built yet'}
              </p>
              {/* The sentence this used to end with — "so there is nothing here to
                  show an inspector" — was removed deliberately. It added no fact
                  the first half does not already carry, and it was the one line on
                  these screens that could be read, over a shoulder, as the
                  RESTAURANT having nothing rather than the SCREEN being unbuilt.
                  Do not put it back. §7 Q11 asks the owner the wider question. */}
              <p className="text-sm text-amber-900 mt-1">
                {notice
                  ? notice.body
                  : `This screen starts working when we build ${phase.brings}. Until then it holds no records of its own.`}
              </p>
              {heldBehindReview && (
                <p className="text-sm text-amber-900 mt-2">
                  That work is deliberately on hold. The build stops once a checklist runs on a phone,
                  so you can try one yourself and say whether it feels right, before eight more record
                  screens are built on top of it.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* What it will do — bullets, not ticks: none of this is done yet. */}
        <div className="bg-white rounded-xl border border-[#E8D5C4] p-4 sm:p-5">
          <h2 className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">
            What this screen will do
          </h2>
          <ul className="mt-3 space-y-2.5">
            {will.map((line, i) => (
              <li key={i} className="flex gap-2.5 text-sm text-[#3D2614]">
                <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-[#af4408] shrink-0" />
                <span className="min-w-0">{line}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Where it happens today — reuse, never duplicate (owner's §21). */}
        {today && (
          <div className="bg-white rounded-xl border border-[#E8D5C4] p-4 sm:p-5">
            <h2 className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">
              Where this is written down today
            </h2>
            <p className="text-sm text-[#3D2614] mt-2.5">{today.text}</p>
            {today.links && today.links.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 mt-3">
                {today.links.map((l) => (
                  <a
                    key={l.href}
                    href={l.href}
                    className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-[#E8D5C4] hover:border-[#af4408] hover:bg-[#FFF1E3] text-[#3D2614] rounded-lg text-sm font-medium transition-colors"
                  >
                    {l.label} <ArrowRight className="w-3.5 h-3.5 text-[#af4408]" />
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Worth knowing now — assumptions, limits, open questions. */}
        {notes && notes.length > 0 && (
          <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-4 sm:p-5">
            <h2 className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">
              Worth knowing now
            </h2>
            <ul className="mt-2.5 space-y-2">
              {notes.map((n, i) => (
                <li key={i} className="text-sm text-[#6B5744]">{n}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="pt-1">
          <a
            href="/fssai"
            className="inline-flex items-center gap-1.5 text-sm text-[#af4408] hover:underline"
          >
            <ArrowLeft className="w-4 h-4" /> Compliance Dashboard
          </a>
        </div>
      </div>
    </div>
  );
}
