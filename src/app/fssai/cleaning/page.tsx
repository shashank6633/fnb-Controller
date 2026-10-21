'use client';

/**
 * Cleaning & Sanitation (owner §8).
 *
 * The record for this area IS a checklist — FSSAI-BUILD-STATE.md §2, from the
 * owner's §24. Three ready-made ones cover it (src/lib/fssai-checklist-pack.ts):
 * the daily kitchen clean, the twice-daily washroom and guest-area round, and
 * the weekly deep clean. Each is signed by whoever did the work, which is the
 * part a cleaning schedule on a wall cannot do.
 *
 * This screen lists them, says when each was last recorded, and leads to the
 * runner or the builder. It owns no table and writes nothing.
 */

import SeededModuleScreen from '../_components/SeededModuleScreen';

export default function FssaiCleaningPage() {
  return (
    <SeededModuleScreen
      href="/fssai/cleaning"
      moduleKey="cleaning"
      covers={[
        'The daily kitchen clean: surfaces, boards, range, hood filters, fridges and the equipment that comes apart.',
        'Floors, drains, grease traps and the waste area — the three things an inspector looks at first.',
        'Sanitiser strength measured on a test strip (50–100 ppm) and the dishwasher final rinse at 82 °C or above.',
        'The twice-daily washroom round: soap, hand drying, running water, and a readable hand-washing notice.',
        'The weekly deep clean behind and underneath, with the name of whoever did it and anything carried over.',
      ]}
    />
  );
}
