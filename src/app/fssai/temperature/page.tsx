'use client';

/**
 * Temperature Logs — Phase 4.
 *
 * Honest shell. This is the register view of the readings the Cold Room screen and
 * the checklists collect; it holds no readings of its own and invents none here.
 */

import PhaseShell from '../_components/PhaseShell';

export default function FssaiTemperaturePage() {
  return (
    <PhaseShell
      href="/fssai/temperature"
      will={[
        'Hold the running record of every temperature taken anywhere in the restaurant — cold rooms and freezers, hot holding, cooking, and cooling after cooking.',
        'Filter by day, by unit and by the person who took the reading.',
        'Show readings outside the safe range in red, with a link to the fix that was carried out and who signed it.',
        'Download or print any date range, so a month of readings can be handed over as one sheet.',
        'Let a reading be corrected only by leaving the original visible with a reason beside it — a temperature record that can be quietly edited is worth nothing.',
      ]}
      today={{
        text:
          'Nowhere. There is no temperature record in the app at all today. The nearest thing is a single pass-or-fail tick on a goods receipt, which does not store the reading itself.',
        links: [{ href: '/grn/qc', label: 'Pending Quality Checks' }],
      }}
      notes={[
        'The safe range for each unit is yours to set on the Settings screen. Nothing here judges a reading against a number that came out of the software.',
        'Readings will be taken on a phone with large plus and minus buttons and no fiddly keyboard, including a minus sign for freezers.',
      ]}
    />
  );
}
