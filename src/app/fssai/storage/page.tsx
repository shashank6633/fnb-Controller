'use client';

/**
 * Food Storage Checks — Phase 8 (a seeded checklist, not a bespoke screen).
 * One of the twelve: configuration the owner edits, run by the Phase 2 builder and
 * the Phase 3 phone runner.
 */

import PhaseShell from '../_components/PhaseShell';

export default function FssaiStoragePage() {
  return (
    <PhaseShell
      href="/fssai/storage"
      will={[
        'Check that raw and cooked are kept apart, everything is covered, and every container is labelled and dated.',
        'Check that nothing is standing on the floor, that allergens are kept separate, and that chemicals are nowhere near food.',
        'Run as three short lists — dry store, cold store and freezer — instead of one long one nobody finishes.',
        'Ask for a photograph when something is wrong, so the storekeeper and the chef see the same thing.',
        'Turn a repeated failure in the same store into a corrective action with a deadline.',
      ]}
      today={{
        text:
          'Nowhere as a storage check. Stock levels and closing counts are recorded, but nothing records the state of the shelves.',
        links: [{ href: '/closing-stock', label: 'Closing Stock' }],
      }}
      notes={[
        'One of twelve ready-made checklists, written once the checklist builder is in place; every question is yours to edit in Settings.',
        'The stores in the list will be the store locations already set up in the app, so there is no second list of places to keep in step.',
      ]}
    />
  );
}
