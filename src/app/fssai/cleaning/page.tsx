'use client';

/**
 * Cleaning & Sanitation — Phase 8 (a seeded checklist, not a bespoke screen).
 * See the note in ../food-quality/page.tsx: these twelve are configuration the
 * owner edits himself, running on the Phase 2 builder and the Phase 3 phone runner.
 */

import PhaseShell from '../_components/PhaseShell';

export default function FssaiCleaningPage() {
  return (
    <PhaseShell
      href="/fssai/cleaning"
      will={[
        'Carry the daily, weekly and deep-clean schedules as checklists, one per area — kitchen line, prep, wash-up, stores, cold rooms, bar, toilets, bins and the back yard.',
        'Record who cleaned what, and at what time, with a signature at the end of the round.',
        'Ask for the dilution and the contact time where the chemical actually matters, instead of a single "cleaned" tick.',
        'Ask for a photograph on the deep cleans, which are the ones that get skipped.',
        'Show up as overdue when a weekly clean has not been done, in the same red the Task Manager already uses.',
      ]}
      today={{
        text:
          'Partly. The Task Manager has a Daily Checklists screen and a Hygiene Audits screen. Neither carries a signature, a shift or a frozen copy of the questions, so neither is enough as a cleaning record. Nothing is taken away from them — the FSSAI checklists sit alongside.',
        links: [
          { href: '/tasks/checklists', label: 'Daily Checklists' },
          { href: '/tasks/hygiene', label: 'Hygiene Audits' },
        ],
      }}
      notes={[
        'One of twelve ready-made checklists arriving in Phase 8. The questions, the frequency and the department responsible are all yours to change in Settings.',
        'The areas have to be your areas. Rather than guess them, Phase 8 will start from the departments and floors already set up in the app and let you adjust the list.',
      ]}
    />
  );
}
