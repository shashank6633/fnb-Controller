'use client';

/**
 * Kitchen Safety Checks (owner §11).
 *
 * The record for this area IS a checklist — FSSAI-BUILD-STATE.md §2, from the
 * owner's §24. Two ready-made ones cover it
 * (src/lib/fssai-checklist-pack.ts): the daily opening walk and the monthly
 * fire, first-aid and equipment audit.
 *
 * ⚠️ IT DOES NOT REPLACE THE MAINTENANCE MODULE, and must not pretend to. A
 * failed answer here raises a corrective action in FSSAI; the actual repair is
 * scheduled where the restaurant already schedules repairs. The one thing P7
 * does NOT yet do is turn that corrective action into a row in the Task Manager
 * — the Corrective Actions screen says so in its own words rather than implying
 * a task exists.
 */

import SeededModuleScreen from '../_components/SeededModuleScreen';

export default function FssaiKitchenSafetyPage() {
  return (
    <SeededModuleScreen
      href="/fssai/kitchen-safety"
      moduleKey="kitchen-safety"
      covers={[
        'Gas first: no smell, pipes and regulators sound, cylinders upright and chained, and everyone on shift knowing where the shut-off is.',
        'Electricals — no exposed wire, no taped joint, nothing switched on over a wet surface.',
        'Guards and covers on the slicer, mixer and grinder, and knives stored in a rack rather than loose in a drawer.',
        'Floors dry, fire exit and gangway clear, extinguishers and fire blanket in place, first-aid box stocked and in date.',
        'The monthly audit: extinguisher and suppression servicing, electrical and gas certificates, probe calibration, and a fire drill actually done.',
      ]}
    />
  );
}
