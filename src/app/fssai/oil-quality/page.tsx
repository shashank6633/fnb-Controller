'use client';

/**
 * Oil Quality Checks — Phase 5.
 * Honest shell. A fryer is a piece of equipment with a threshold, so it is
 * registered on the Settings screen alongside the cold units — nothing about oil is
 * written into the software.
 */

import PhaseShell from '../_components/PhaseShell';

export default function FssaiOilQualityPage() {
  return (
    <PhaseShell
      href="/fssai/oil-quality"
      will={[
        'Check fryer oil by how it looks, how it smells, how much it foams, and — where you use a meter — the reading it gives.',
        'Record filtering and topping up separately from a full change, because they are not the same thing.',
        'Record an oil change with the date, the quantity and who did it, so cost and safety are the same record.',
        'Tell the kitchen when a reading has passed the limit you set, and keep the proof that the oil was then changed.',
        'Show each fryer’s history, so an oil going off faster than it should is visible.',
      ]}
      today={{
        text:
          'Nowhere. Cooking oil is bought and issued like any other item, but nothing records its condition in the fryer.',
        links: [{ href: '/inventory', label: 'Raw Materials' }],
      }}
      notes={[
        'The limit is yours to set per fryer on the Settings screen, in whatever your meter reads. If you do not use a meter, the check works on look, smell and foam alone.',
        'Fryers are registered in the same equipment list as the cold rooms, so one screen covers both.',
      ]}
    />
  );
}
