'use client';

/**
 * Cold Room Climate Control — Phase 4.
 *
 * Honest shell. There is no equipment master anywhere in this app — Phase 1 created
 * the place to register cold units (an exhaustive search of all 205 existing tables
 * found nothing to reuse; hr_assets registers uniforms and ID cards, not chillers).
 * The only cold units that exist today are the words typed on kitchen batch labels,
 * and this page says exactly that instead of inventing a list of equipment.
 */

import PhaseShell from '../_components/PhaseShell';

export default function FssaiColdRoomsPage() {
  return (
    <PhaseShell
      href="/fssai/cold-rooms"
      will={[
        'Show one card per cold room, chiller and freezer, with the safe range you set for it and its most recent reading.',
        'Take the morning and evening readings in two taps each, with the name of the person who took them.',
        'Show at a glance how long it has been since each unit was last read, so a unit nobody checked stands out.',
        'Raise a corrective action the moment a reading lands outside the range — not at the end of the day.',
        'Keep the history of every unit, so you can see whether a chiller has been drifting for a fortnight.',
      ]}
      today={{
        text:
          'Nowhere. Your cold units are not a list in this app yet — they exist only as free text typed on kitchen production labels, where the words used so far are Cold Room 1, Cold Room 2, Cold Room 3 and walkin chiller 1. The place to register them properly is already built; you will name them, and set each one’s safe range, on the Settings screen.',
        links: [{ href: '/kitchen-production', label: 'Kitchen Production' }],
      }}
      notes={[
        'Safe ranges are yours to set, one per unit, on the Settings screen. No temperature is written into the software — a freezer, a walk-in and a dessert chiller are not the same, and the rules also change.',
        'When you register the units we will use those exact four names first, so the batches already labelled with them line up instead of starting a fresh list.',
      ]}
    />
  );
}
