'use client';

/**
 * FSSAI Compliance — Dashboard (/fssai index).
 *
 * WHAT THIS IS IN PHASE 1, AND WHAT IT IS NOT. It is the map of the module: the
 * twenty screens, what each one is for, and which phase makes it work. It shows
 * NO figures — no "checks due today", no compliance percentage, no pass rate —
 * because nothing has been recorded yet and a dashboard of zeroes (or worse, of
 * invented numbers) on a food-safety screen is something somebody could put in
 * front of an inspector. The live counts arrive in Phase 9, once there are
 * records to count.
 *
 * Deliberately NO fetch. There is no /api/fssai route in Phase 1, so a page that
 * called one would only be able to show an error banner. Every word on this
 * screen is true without asking the server anything.
 *
 * Style is the house skeleton (docs/fssai/RECON.md §1.3) and the tile/quick-action
 * shapes are the ones src/app/hr/page.tsx and src/app/tasks/page.tsx already use.
 */

import { AlertTriangle, ArrowRight, Hourglass, Lock, ShieldCheck } from 'lucide-react';
import {
  FSSAI_MODULES,
  fssaiAccessLabel,
  fssaiPhase,
  type FssaiGroup,
  type FssaiModule,
} from './_components/modules';

/** The three bands, in the order the owner listed his screens. */
const BANDS: Array<{ key: FssaiGroup; title: string; sub: string }> = [
  {
    key: 'checks',
    title: 'The checks themselves',
    sub: 'What staff stand in front of and record, mostly on a phone.',
  },
  {
    key: 'records',
    title: 'Follow-up and the file',
    sub: 'What happens after a check fails, and the paperwork an inspector asks for.',
  },
  {
    key: 'setup',
    title: 'Reports and your standards',
    sub: 'What you read, what you hand over, and the settings everything else obeys.',
  },
];

export default function FssaiDashboardPage() {
  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* Header */}
        <div className="flex flex-wrap items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <ShieldCheck size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">
              FSSAI Compliance
            </p>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">Compliance Dashboard</h1>
            <p className="text-sm text-[#6B5744] mt-1">
              Every food-safety check the restaurant runs, in one place — who owes what today, what
              failed, and what an inspector would ask to see.
            </p>
          </div>
        </div>

        {/* The honest headline. No figures, and the reason why. */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <Hourglass className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="font-bold text-amber-900">No checks have been recorded yet</p>
              <p className="text-sm text-amber-900 mt-1">
                This dashboard shows no counts because there is nothing to count. Checklists cannot be
                filled in until Phase 2 builds the checklist itself and Phase 3 puts it on a phone.
                The figures you will eventually read here — due today, missed, failed and waiting on a
                fix, certificates about to run out — arrive in Phase 9.
              </p>
              <p className="text-sm text-amber-900 mt-2">
                The build stops after Phase 3 on purpose, so you can run a checklist on your own phone
                and say whether it feels right before the eight record screens are built on top of it.
              </p>
            </div>
          </div>
        </div>

        {/* What Phase 1 actually delivered. Stated plainly, so nothing is implied. */}
        <div className="bg-white rounded-xl border border-[#E8D5C4] p-4 sm:p-5">
          <h2 className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">
            What is in place today
          </h2>
          <ul className="mt-3 space-y-2.5">
            {[
              'The store for the records is built — new tables inside the app’s own database, checked every time the app starts so a missing one is reported instead of quietly failing.',
              'All twenty screens below exist and open, on a phone and on a computer. None of them holds a record yet.',
              'Who sees what is set: most screens are open to any signed-in staff member, while Inspection Reports, Documents & Certificates, Reports & Downloads and Inspection Mode are management, and Settings is yours alone.',
              'Nothing about the way stock moves has changed. This module watches and records; it never moves material.',
            ].map((line, i) => (
              <li key={i} className="flex gap-2.5 text-sm text-[#3D2614]">
                <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-[#af4408] shrink-0" />
                <span className="min-w-0">{line}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* The module map */}
        {BANDS.map((band) => {
          const rows = FSSAI_MODULES.filter((m) => m.group === band.key);
          return (
            <section key={band.key} className="space-y-3">
              <div>
                <h2 className="text-lg font-semibold text-[#2D1B0E]">{band.title}</h2>
                <p className="text-xs text-[#8B7355] mt-0.5">{band.sub}</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4">
                {rows.map((m) => (
                  <ModuleTile key={m.href} mod={m} />
                ))}
              </div>
            </section>
          );
        })}

        <div className="flex items-start gap-2 text-xs text-[#8B7355] pt-1">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <p>
            Every screen in this list is honest about what it does not yet hold. Nowhere in this
            module is there a made-up reading, a sample record or a placeholder row that could be
            mistaken for evidence.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ── page-local tile (the /hr QuickAction shape, grown into a card) ── */

function ModuleTile({ mod }: { mod: FssaiModule }) {
  const Icon = mod.icon;
  const phase = fssaiPhase(mod.phase);
  const accessLabel = fssaiAccessLabel(mod.access);
  return (
    <a
      href={mod.href}
      className="group bg-white border border-[#E8D5C4] rounded-xl p-4 flex flex-col gap-2 hover:border-[#af4408] transition-colors"
    >
      <div className="flex items-start gap-2.5">
        <div className="p-1.5 rounded-lg bg-[#af4408]/10 shrink-0">
          <Icon className="w-4 h-4 text-[#af4408]" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[#2D1B0E] leading-snug">{mod.label}</p>
          <p className="text-xs text-[#6B5744] mt-1">{mod.blurb}</p>
        </div>
        <ArrowRight className="w-4 h-4 text-[#C4B09A] group-hover:text-[#af4408] shrink-0" />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 mt-auto pt-1">
        <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full border bg-[#FFF1E3] text-[#8B7355] border-[#E8D5C4]">
          {phase.name}
        </span>
        {accessLabel && (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border bg-purple-100 text-purple-700 border-purple-200">
            <Lock className="w-3 h-3" /> {accessLabel}
          </span>
        )}
      </div>
    </a>
  );
}
