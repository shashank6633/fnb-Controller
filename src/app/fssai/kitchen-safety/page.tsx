'use client';

/**
 * Kitchen Safety Checks — Phase 8 (a seeded checklist, not a bespoke screen).
 * A failure here should become a MAINTENANCE job in the existing Task Manager, not
 * a note in a new silo — that link is Phase 7's work and is promised as such.
 */

import PhaseShell from '../_components/PhaseShell';

export default function FssaiKitchenSafetyPage() {
  return (
    <PhaseShell
      href="/fssai/kitchen-safety"
      will={[
        'Check the gas points and hoses, the electrical points, and how clean the hood and ducts are.',
        'Check the fire extinguisher service dates, the fire blanket, and that the first-aid box is stocked.',
        'Check knives, slicers and their guards, and the wet or slippery floor spots.',
        'Send anything unsafe straight to Maintenance as a job with an owner and a date — not just a line in a report.',
        'Keep the record of who checked, when, and what was found, so a repeat fault has a history.',
      ]}
      today={{
        text:
          'Partly. Maintenance schedules and maintenance jobs already exist in the Task Manager, and equipment faults belong there. What does not exist is the routine safety walk that finds them.',
        links: [{ href: '/tasks/maintenance', label: 'Maintenance' }],
      }}
      notes={[
        'One of twelve ready-made checklists, written once the checklist builder is in place; the questions are yours to edit in Settings.',
        'A fault found here will create a job in the Maintenance screen you already use. This module will not grow a second to-do list.',
      ]}
    />
  );
}
